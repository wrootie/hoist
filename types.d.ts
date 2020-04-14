export interface HoistServer {
  port: number;
  url: string;
  root: string;
  async stop(): void;
}

export function deploy(root: string, directory?: string, bucket?: string): Promise<string>;
export function makePublic(root: string, bucket?: string): Promise<void>;
export function makePrivate(root: string, bucket?: string): Promise<void>;
export function serve(root: string, port?: number, autoOpen?: boolean | string): Promise<HoistServer>;
