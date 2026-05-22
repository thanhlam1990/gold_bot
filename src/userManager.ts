import fs from 'fs';
import path from 'path';
import { logger } from './logger';

export interface VipUser {
  chatId: string;
  username?: string;
  expireAt: number; // timestamp in ms
  isActive: boolean;
}

export class UserManager {
  private usersPath: string;
  private users: Map<string, VipUser> = new Map();

  constructor() {
    const dataDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    this.usersPath = path.join(dataDir, 'vip_users.json');
    this.load();
  }

  private load(): void {
    if (fs.existsSync(this.usersPath)) {
      try {
        const raw = fs.readFileSync(this.usersPath, 'utf8');
        const data: VipUser[] = JSON.parse(raw);
        for (const user of data) {
          this.users.set(user.chatId, user);
        }
        logger.info(`Loaded ${this.users.size} VIP users.`);
      } catch (err) {
        logger.error(`Failed to load VIP users: ${(err as Error).message}`);
      }
    }
  }

  private save(): void {
    try {
      const data = Array.from(this.users.values());
      fs.writeFileSync(this.usersPath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      logger.error(`Failed to save VIP users: ${(err as Error).message}`);
    }
  }

  public addVip(chatId: string, days: number, username?: string): void {
    const expireAt = Date.now() + days * 24 * 60 * 60 * 1000;
    this.users.set(chatId, {
      chatId,
      username,
      expireAt,
      isActive: true
    });
    this.save();
  }

  public removeVip(chatId: string): void {
    if (this.users.has(chatId)) {
      const user = this.users.get(chatId)!;
      user.isActive = false;
      this.save();
    }
  }

  public getActiveVips(): VipUser[] {
    const now = Date.now();
    const active: VipUser[] = [];
    let changed = false;

    for (const user of this.users.values()) {
      if (user.isActive) {
        if (user.expireAt > now) {
          active.push(user);
        } else {
          user.isActive = false;
          changed = true;
        }
      }
    }

    if (changed) {
      this.save();
    }

    return active;
  }

  public getAllUsers(): VipUser[] {
    return Array.from(this.users.values());
  }

  public isVip(chatId: string): boolean {
    const user = this.users.get(chatId);
    if (!user) return false;
    if (user.isActive && user.expireAt > Date.now()) return true;
    
    // Auto deactivate if expired
    if (user.isActive && user.expireAt <= Date.now()) {
      user.isActive = false;
      this.save();
    }
    return false;
  }
}
