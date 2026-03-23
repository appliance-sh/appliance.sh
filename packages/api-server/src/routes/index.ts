import { Router } from 'express';

export const indexRoutes: Router = Router();

indexRoutes.get('/', (_req, res) => {
  res.send('Hello World!');
});
