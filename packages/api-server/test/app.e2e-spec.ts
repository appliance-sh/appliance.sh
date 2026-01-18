import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/main';
import type { Express } from 'express';

describe('App (e2e)', () => {
  let app: Express;

  beforeAll(() => {
    app = createApp();
  });

  it('/ (GET)', async () => {
    const response = await request(app).get('/');
    expect(response.status).toBe(200);
    expect(response.text).toBe('Hello World!');
  });
});
