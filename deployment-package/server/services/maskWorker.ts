import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import Sharp from 'sharp';
import type { MaskData } from '@shared/schema';
import path from 'path';
import { cpus } from 'os';
import { fileURLToPath } from 'url';

export interface WorkerTask {
  frameBuffer: Buffer;
  maskData: MaskData;
  outputSize: { width: number; height: number };
  frameNumber: number;
}

export interface WorkerResult {
  frameNumber: number;
  processedBuffer: Buffer;
  success: boolean;
  error?: string;
}

export class MaskWorkerPool {
  private workers: Worker[] = [];
  private taskQueue: Array<{ task: WorkerTask; resolve: Function; reject: Function }> = [];
  private busyWorkers: Set<number> = new Set();
  private workerCount: number;

  constructor(workerCount: number = Math.min(cpus().length, 8)) {
    this.workerCount = workerCount;
    this.initializeWorkers();
  }

  private initializeWorkers() {
    for (let i = 0; i < this.workerCount; i++) {
      const worker = new Worker(fileURLToPath(import.meta.url));
      
      worker.on('message', (result: WorkerResult) => {
        this.busyWorkers.delete(i);
        this.processNextTask();
        
        // Find and resolve the corresponding task
        if (result.success) {
          // Handle successful result
        } else {
          // Handle error result
        }
      });

      worker.on('error', (error) => {
        console.error(`Worker ${i} error:`, error);
        this.busyWorkers.delete(i);
        this.processNextTask();
      });

      this.workers[i] = worker;
    }
  }

  async processFrame(task: WorkerTask): Promise<WorkerResult> {
    return new Promise((resolve, reject) => {
      this.taskQueue.push({ task, resolve, reject });
      this.processNextTask();
    });
  }

  private processNextTask() {
    if (this.taskQueue.length === 0) return;

    // Find available worker
    const availableWorkerIndex = this.workers.findIndex((_, index) => !this.busyWorkers.has(index));
    if (availableWorkerIndex === -1) return;

    const { task, resolve, reject } = this.taskQueue.shift()!;
    this.busyWorkers.add(availableWorkerIndex);

    const worker = this.workers[availableWorkerIndex];
    
    // Set up one-time listener for this specific task
    const handleMessage = (result: WorkerResult) => {
      worker.off('message', handleMessage);
      if (result.success) {
        resolve(result);
      } else {
        reject(new Error(result.error));
      }
    };

    worker.on('message', handleMessage);
    worker.postMessage(task);
  }

  async terminate() {
    await Promise.all(this.workers.map(worker => worker.terminate()));
  }
}

// Worker thread implementation
if (!isMainThread) {
  parentPort?.on('message', async (task: WorkerTask) => {
    try {
      const result = await processFrameWithMask(task);
      parentPort?.postMessage(result);
    } catch (error) {
      parentPort?.postMessage({
        frameNumber: task.frameNumber,
        processedBuffer: Buffer.alloc(0),
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      } as WorkerResult);
    }
  });
}

async function processFrameWithMask(task: WorkerTask): Promise<WorkerResult> {
  try {
    const { frameBuffer, maskData, outputSize, frameNumber } = task;

    // Load the frame image
    let image = Sharp(frameBuffer);
    
    // Get image metadata to calculate mask coordinates
    const metadata = await image.metadata();
    const originalWidth = metadata.width || 1920;
    const originalHeight = metadata.height || 1080;

    // Create mask based on mask data
    const maskBuffer = await createMaskBuffer(maskData, originalWidth, originalHeight);

    // Apply mask to image
    let processedImage = image.composite([{
      input: maskBuffer,
      blend: 'dest-in'
    }]);

    // Resize to output dimensions
    processedImage = processedImage.resize(outputSize.width, outputSize.height, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    });

    // Convert to PNG buffer
    const processedBuffer = await processedImage.png().toBuffer();

    return {
      frameNumber,
      processedBuffer,
      success: true
    };
  } catch (error) {
    return {
      frameNumber: task.frameNumber,
      processedBuffer: Buffer.alloc(0),
      success: false,
      error: error instanceof Error ? error.message : 'Unknown processing error'
    };
  }
}

async function createMaskBuffer(maskData: MaskData, width: number, height: number): Promise<Buffer> {
  let maskSvg = '';

  switch (maskData.type) {
    case 'rectangle':
      const [x, y, w, h] = maskData.coordinates;
      maskSvg = `
        <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
          <rect x="${x}" y="${y}" width="${w}" height="${h}" 
                fill="white" opacity="${maskData.opacity / 100}" />
        </svg>
      `;
      break;

    case 'circle':
      const [cx, cy, radius] = maskData.coordinates;
      maskSvg = `
        <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
          <circle cx="${cx}" cy="${cy}" r="${radius}" 
                  fill="white" opacity="${maskData.opacity / 100}" />
        </svg>
      `;
      break;

    case 'polygon':
      const points = [];
      for (let i = 0; i < maskData.coordinates.length; i += 2) {
        points.push(`${maskData.coordinates[i]},${maskData.coordinates[i + 1]}`);
      }
      maskSvg = `
        <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
          <polygon points="${points.join(' ')}" 
                   fill="white" opacity="${maskData.opacity / 100}" />
        </svg>
      `;
      break;

    default:
      // Default to full frame mask
      maskSvg = `
        <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
          <rect x="0" y="0" width="${width}" height="${height}" 
                fill="white" opacity="${maskData.opacity / 100}" />
        </svg>
      `;
  }

  // Apply feather effect if specified
  if (maskData.feather > 0) {
    // Add blur filter to SVG correctly
    const defsSection = `<defs><filter id="blur"><feGaussianBlur stdDeviation="${maskData.feather}" /></filter></defs>`;
    maskSvg = maskSvg.replace('<svg', `<svg`);
    maskSvg = maskSvg.replace('xmlns="http://www.w3.org/2000/svg">', `xmlns="http://www.w3.org/2000/svg">${defsSection}`);
    maskSvg = maskSvg.replace(/fill="white"/g, 'fill="white" filter="url(#blur)"');
  }

  return Sharp(Buffer.from(maskSvg)).png().toBuffer();
}
