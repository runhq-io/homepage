import { Hono } from 'hono';
import authorize from './authorize';
import token from './token';
import revoke from './revoke';
import userinfo from './userinfo';

const oauth = new Hono();

oauth.route('/', authorize);
oauth.route('/', token);
oauth.route('/', revoke);
oauth.route('/', userinfo);

export default oauth;
