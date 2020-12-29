export interface HoistServer {
  port: number;
  url: string;
  root: string;
  async stop(): void;
}

export interface Logger {
  log: (...any) => void;
  error: (...any) => void;
  warn: (...any) => void;
}

export function cdnFileName(buffer: string): string;
export function deploy(root: string, directory?: string, bucket?: string, logger?: Logger, autoDelete?: boolean): Promise<string>;
export function makePublic(root: string, bucket?: string): Promise<void>;
export function makePrivate(root: string, bucket?: string): Promise<void>;
export function serve(root: string, port?: number, autoOpen?: boolean | string): Promise<HoistServer>;
