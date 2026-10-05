import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env';

export interface StorageService {
  save(key: string, data: Buffer): Promise<string>;
  read(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

/** Local-disk storage (development / single node). Replace with an S3/R2/Supabase implementation of StorageService. */
export class LocalStorage implements StorageService {
  private root = path.resolve(env.STORAGE_DIR);

  private resolve(key: string) {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error('Invalid storage key'); // path traversal guard
    return full;
  }

  async save(key: string, data: Buffer) {
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, data);
    return key;
  }

  async read(key: string) {
    return fs.readFile(this.resolve(key));
  }

  async remove(key: string) {
    await fs.rm(this.resolve(key), { force: true });
  }
}

export const storage: StorageService = new LocalStorage();

export const invoiceFileKey = (organizationId: string, invoiceId: string, safeName: string) =>
  `organizations/${organizationId}/invoices/${invoiceId}/${safeName}`;
