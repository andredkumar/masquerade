import fs from 'fs/promises';
import path from 'path';

export class TempFolderManager {
  private static readonly TEMP_BASE = path.join(process.cwd(), 'temp_processed');
  
  /**
   * Create a temporary folder for a job
   */
  static async createJobTempFolder(jobId: string): Promise<string> {
    const folderPath = path.join(this.TEMP_BASE, jobId);
    
    try {
      await fs.mkdir(folderPath, { recursive: true });
      console.log(`📁 Created temp folder: ${folderPath}`);
      return folderPath;
    } catch (error) {
      console.error('Error creating temp folder:', error);
      throw error;
    }
  }
  
  /**
   * Clean up a specific job's temporary folder
   */
  static async cleanupJobTempFolder(jobId: string): Promise<void> {
    const folderPath = path.join(this.TEMP_BASE, jobId);
    
    try {
      await fs.rm(folderPath, { recursive: true, force: true });
      console.log(`🗑️ Cleaned up temp folder: ${folderPath}`);
    } catch (error) {
      console.error('Error cleaning up temp folder:', error);
      // Don't throw error - cleanup should be non-blocking
    }
  }
  
  /**
   * Clean up all temporary folders
   */
  static async cleanupAllTempFolders(): Promise<void> {
    try {
      await fs.rm(this.TEMP_BASE, { recursive: true, force: true });
      console.log(`🗑️ Cleaned up all temp folders`);
    } catch (error) {
      console.error('Error cleaning up all temp folders:', error);
      // Don't throw error - cleanup should be non-blocking
    }
  }
  
  /**
   * Get the path to a job's temporary folder
   */
  static getJobTempFolder(jobId: string): string {
    return path.join(this.TEMP_BASE, jobId);
  }
  
  /**
   * Save a processed image to the job's temp folder
   */
  static async saveProcessedImage(
    jobId: string, 
    imageIndex: number, 
    imageBuffer: Buffer, 
    originalName: string
  ): Promise<string> {
    const folderPath = this.getJobTempFolder(jobId);
    
    // Ensure folder exists
    await fs.mkdir(folderPath, { recursive: true });
    
    // Create filename with index and original name
    const extension = path.extname(originalName) || '.png';
    const filename = `image_${String(imageIndex + 1).padStart(3, '0')}_${path.basename(originalName, extension)}${extension}`;
    const filePath = path.join(folderPath, filename);
    
    await fs.writeFile(filePath, imageBuffer);
    console.log(`💾 Saved processed image: ${filePath}`);
    
    return filePath;
  }
  
  /**
   * Get all processed images from a job's temp folder
   */
  static async getProcessedImages(jobId: string): Promise<string[]> {
    const folderPath = this.getJobTempFolder(jobId);
    
    try {
      const files = await fs.readdir(folderPath);
      const imagePaths = files
        .filter(file => file.match(/\.(png|jpg|jpeg)$/i))
        .sort()
        .map(file => path.join(folderPath, file));
      
      return imagePaths;
    } catch (error) {
      console.error('Error reading processed images:', error);
      return [];
    }
  }
  
  /**
   * Check if a job has processed images
   */
  static async hasProcessedImages(jobId: string): Promise<boolean> {
    const images = await this.getProcessedImages(jobId);
    return images.length > 0;
  }
  
  /**
   * Initialize temp folder system (create base directory)
   */
  static async initialize(): Promise<void> {
    try {
      await fs.mkdir(this.TEMP_BASE, { recursive: true });
    } catch (error) {
      console.error('Error initializing temp folder system:', error);
    }
  }
}