import fs from 'fs';
import path from 'path';
import { logger } from './logger';

export interface VipUser {
  chatId: string;
  username?: string;
  expireAt: number; // timestamp in ms
  isActive: boolean;
}

// Cùng thư mục 'data' với history.json
const DATA_DIR = 'data';
const USERS_FILE = path.join(DATA_DIR, 'vip_users.json');

export class UserManager {
  constructor() {
    this.ensureDataDir();
  }

  /** Đảm bảo thư mục data/ và file JSON tồn tại */
  private ensureDataDir(): void {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        logger.info(`Created data directory: ${DATA_DIR}`);
      }
      if (!fs.existsSync(USERS_FILE)) {
        fs.writeFileSync(USERS_FILE, JSON.stringify([], null, 2), 'utf-8');
        logger.info(`Created users file: ${USERS_FILE}`);
      }
    } catch (err) {
      logger.error(`Failed to initialize data directory: ${(err as Error).message}`);
    }
  }

  /** Đọc toàn bộ danh sách user từ file JSON */
  private readUsers(): VipUser[] {
    try {
      const raw = fs.readFileSync(USERS_FILE, 'utf-8');
      return JSON.parse(raw) as VipUser[];
    } catch (err) {
      logger.error(`Failed to read users file: ${(err as Error).message}`);
      return [];
    }
  }

  /** Ghi danh sách user xuống file JSON */
  private writeUsers(users: VipUser[]): void {
    try {
      fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf-8');
    } catch (err) {
      logger.error(`Failed to write users file: ${(err as Error).message}`);
    }
  }

  public async addVip(chatId: string, days: number, username?: string): Promise<void> {
    const users = this.readUsers();
    const expireAt = Date.now() + days * 24 * 60 * 60 * 1000;
    const idx = users.findIndex(u => u.chatId === chatId);

    if (idx >= 0) {
      // Cập nhật nếu đã tồn tại
      users[idx] = { chatId, username: username || users[idx].username, expireAt, isActive: true };
      logger.info(`Updated VIP: ${chatId} (${username ?? '-'}), expires in ${days} day(s).`);
    } else {
      // Thêm mới
      users.push({ chatId, username, expireAt, isActive: true });
      logger.info(`Added VIP: ${chatId} (${username ?? '-'}), expires in ${days} day(s).`);
    }

    this.writeUsers(users);
  }

  public async removeVip(chatId: string): Promise<void> {
    const users = this.readUsers();
    const idx = users.findIndex(u => u.chatId === chatId);

    if (idx >= 0) {
      users[idx].isActive = false;
      this.writeUsers(users);
      logger.info(`Deactivated VIP: ${chatId}`);
    }
  }

  public async getActiveVips(): Promise<VipUser[]> {
    const now = Date.now();
    let users = this.readUsers();

    // Auto-deactivate expired users
    let dirty = false;
    users = users.map(u => {
      if (u.isActive && u.expireAt <= now) {
        dirty = true;
        return { ...u, isActive: false };
      }
      return u;
    });

    if (dirty) this.writeUsers(users);

    return users.filter(u => u.isActive);
  }

  public async getAllUsers(): Promise<VipUser[]> {
    return this.readUsers();
  }

  public async isVip(chatId: string): Promise<boolean> {
    const now = Date.now();
    const users = this.readUsers();
    const user = users.find(u => u.chatId === chatId);

    if (!user) return false;

    if (user.isActive && user.expireAt > now) return true;

    // Expired → deactivate
    if (user.isActive && user.expireAt <= now) {
      const updated = users.map(u =>
        u.chatId === chatId ? { ...u, isActive: false } : u
      );
      this.writeUsers(updated);
    }

    return false;
  }
}
