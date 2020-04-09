export interface HoistServer {
  port: number;
  url: string;
  root: string;
  async stop(): void;
}

export function deploy(workingDir: string, userBucket?: string): Promise<string>;
export function makePublic(workingDir: string, userBucket?: string): Promise<void>;
export function makePrivate(workingDir: string, userBucket?: string): Promise<void>;
export function serve(workingDir: string, port?: number, autoOpen?: boolean | string): Promise<HoistServer>;
