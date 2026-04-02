declare module 'unzipper' {
  import { Readable } from 'stream';

  interface File {
    path: string;
    type: string;
    buffer(): Promise<Buffer>;
    stream(): Readable;
  }

  interface CentralDirectory {
    files: File[];
  }

  export const Open: {
    file(path: string): Promise<CentralDirectory>;
    buffer(buffer: Buffer): Promise<CentralDirectory>;
  };
}
