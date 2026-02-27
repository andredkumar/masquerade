import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface SystemCheckResult {
  ffmpegInstalled: boolean;
  ffprobeInstalled: boolean;
  ffmpegVersion?: string;
  ffprobeVersion?: string;
  error?: string;
}

export async function checkFFmpegInstallation(): Promise<SystemCheckResult> {
  const result: SystemCheckResult = {
    ffmpegInstalled: false,
    ffprobeInstalled: false
  };

  try {
    // Check FFmpeg
    try {
      const { stdout: ffmpegOutput } = await execAsync('ffmpeg -version');
      const versionMatch = ffmpegOutput.match(/ffmpeg version ([^\s]+)/);
      result.ffmpegInstalled = true;
      result.ffmpegVersion = versionMatch ? versionMatch[1] : 'unknown';
    } catch (error) {
      console.warn('FFmpeg not found or not working');
    }

    // Check FFprobe
    try {
      const { stdout: ffprobeOutput } = await execAsync('ffprobe -version');
      const versionMatch = ffprobeOutput.match(/ffprobe version ([^\s]+)/);
      result.ffprobeInstalled = true;
      result.ffprobeVersion = versionMatch ? versionMatch[1] : 'unknown';
    } catch (error) {
      console.warn('FFprobe not found or not working');
    }

  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Unknown system check error';
  }

  return result;
}

export function displaySystemStatus(checkResult: SystemCheckResult): void {
  console.log('\n🔍 SYSTEM DEPENDENCIES CHECK');
  console.log('===============================');
  
  if (checkResult.ffmpegInstalled && checkResult.ffprobeInstalled) {
    console.log('✅ FFmpeg: INSTALLED', `(${checkResult.ffmpegVersion})`);
    console.log('✅ FFprobe: INSTALLED', `(${checkResult.ffprobeVersion})`);
    console.log('🎬 Video processing: READY');
  } else {
    console.log('❌ FFmpeg Status:');
    console.log(`   FFmpeg: ${checkResult.ffmpegInstalled ? '✅ Installed' : '❌ Missing'}`);
    console.log(`   FFprobe: ${checkResult.ffprobeInstalled ? '✅ Installed' : '❌ Missing'}`);
    console.log('');
    console.log('⚠️  WARNING: Video file uploads (.mp4, .mov, .avi) will fail!');
    console.log('   DICOM and image files will work normally.');
    console.log('');
    console.log('🛠️  To fix this:');
    console.log('   1. Run: ./install-ffmpeg.sh (if available)');
    console.log('   2. Or install manually:');
    console.log('      Amazon Linux: sudo yum install -y ffmpeg ffmpeg-devel');
    console.log('      Ubuntu/Debian: sudo apt install -y ffmpeg');
  }
  
  console.log('===============================\n');
}