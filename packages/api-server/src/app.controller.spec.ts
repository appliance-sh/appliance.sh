import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from './main';

describe('Index Route', () => {
  it('should return "Hello World!"', async () => {
    const app = createApp();
    const response = await request(app).get('/');
    expect(response.status).toBe(200);
    expect(response.text).toBe('Hello World!');
  });
});

describe('Authenticated routes', () => {
  it('should return 401 for /api/v1/projects without auth', async () => {
    const app = createApp();
    const response = await request(app).get('/api/v1/projects');
    expect(response.status).toBe(401);
    expect(response.body.error).toBe('Missing signature headers');
  });
});
