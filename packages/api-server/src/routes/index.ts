import { Router } from 'express';

export const indexRoutes = Router();

indexRoutes.get('/', (_req, res) => {
  res.send('Hello World!');
});
