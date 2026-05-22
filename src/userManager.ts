import { Pool } from 'pg';
import { logger } from './logger';

export interface VipUser {
  chatId: string;
  username?: string;
  expireAt: number; // timestamp in ms
  isActive: boolean;
}

export class UserManager {
  private pool: Pool;
  private isConnected: boolean = false;

  constructor() {
    const connectionString = process.env.DATABASE_URL || 'postgresql://thanhlam:3IVjUHha3dLthW7LZZUE1cjeb8GcDM3v@dpg-d87sphu7r5hc73f1va10-a.singapore-postgres.render.com/goldbot_db';
    
    this.pool = new Pool({
      connectionString,
      ssl: {
        rejectUnauthorized: false
      }
    });

    this.initDb();
  }

  private async initDb() {
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS vip_users (
          chat_id VARCHAR(255) PRIMARY KEY,
          username VARCHAR(255),
          expire_at BIGINT NOT NULL,
          is_active BOOLEAN NOT NULL DEFAULT TRUE
        );
      `);
      this.isConnected = true;
      logger.info('Connected to PostgreSQL and verified vip_users table.');
    } catch (err) {
      logger.error(`Database initialization failed: ${(err as Error).message}`);
    }
  }

  public async addVip(chatId: string, days: number, username?: string): Promise<void> {
    if (!this.isConnected) return;
    const expireAt = Date.now() + days * 24 * 60 * 60 * 1000;
    try {
      await this.pool.query(`
        INSERT INTO vip_users (chat_id, username, expire_at, is_active)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (chat_id) 
        DO UPDATE SET expire_at = EXCLUDED.expire_at, is_active = EXCLUDED.is_active, username = EXCLUDED.username;
      `, [chatId, username || null, expireAt, true]);
    } catch (err) {
      logger.error(`Failed to add VIP: ${(err as Error).message}`);
    }
  }

  public async removeVip(chatId: string): Promise<void> {
    if (!this.isConnected) return;
    try {
      await this.pool.query(`
        UPDATE vip_users SET is_active = false WHERE chat_id = $1;
      `, [chatId]);
    } catch (err) {
      logger.error(`Failed to remove VIP: ${(err as Error).message}`);
    }
  }

  public async getActiveVips(): Promise<VipUser[]> {
    if (!this.isConnected) return [];
    const now = Date.now();
    try {
      // Auto-deactivate expired first
      await this.pool.query(`
        UPDATE vip_users SET is_active = false WHERE is_active = true AND expire_at <= $1;
      `, [now]);

      const res = await this.pool.query(`
        SELECT chat_id, username, expire_at, is_active FROM vip_users WHERE is_active = true;
      `);

      return res.rows.map((r: any) => ({
        chatId: r.chat_id,
        username: r.username,
        expireAt: parseInt(r.expire_at),
        isActive: r.is_active
      }));
    } catch (err) {
      logger.error(`Failed to get active VIPs: ${(err as Error).message}`);
      return [];
    }
  }

  public async getAllUsers(): Promise<VipUser[]> {
    if (!this.isConnected) return [];
    try {
      const res = await this.pool.query(`SELECT chat_id, username, expire_at, is_active FROM vip_users`);
      return res.rows.map((r: any) => ({
        chatId: r.chat_id,
        username: r.username,
        expireAt: parseInt(r.expire_at),
        isActive: r.is_active
      }));
    } catch (err) {
      logger.error(`Failed to get all users: ${(err as Error).message}`);
      return [];
    }
  }

  public async isVip(chatId: string): Promise<boolean> {
    if (!this.isConnected) return false;
    try {
      const res = await this.pool.query(`
        SELECT expire_at, is_active FROM vip_users WHERE chat_id = $1
      `, [chatId]);

      if (res.rows.length === 0) return false;
      const user = res.rows[0];

      if (user.is_active && parseInt(user.expire_at) > Date.now()) return true;

      if (user.is_active && parseInt(user.expire_at) <= Date.now()) {
        await this.pool.query(`UPDATE vip_users SET is_active = false WHERE chat_id = $1`, [chatId]);
      }

      return false;
    } catch (err) {
      logger.error(`Failed to check VIP status: ${(err as Error).message}`);
      return false;
    }
  }
}
