import { users } from '../db.js';

/** 匿名账户鉴权：X-User-Token → req.user（余额挂 token，丢失即丢余额） */
export function userAuth(req, res, next) {
  const token = String(req.get('x-user-token') || '');
  if (!token) {
    return res.status(401).json({ error: 'no_user_token', message: '缺少 X-User-Token（先 POST /api/user 匿名开户）' });
  }
  const u = users.get(token);
  if (!u) return res.status(401).json({ error: 'bad_user_token', message: 'user_token 无效' });
  users.touch(token);
  req.user = u;
  next();
}
