import type { SingleRelation } from '@spinajs/orm';
import { Post, User } from './models.js';

/** Has every member a reader could look at on a Post, but is no model class. */
interface PostShaped {
  Id: number;
  Title: string;
  Owner: SingleRelation<User>;
}

export declare const plain: Post;
export declare const withObject: Post & { Extra: string };
export declare const shapedOnly: PostShaped & { Extra: string };
export declare const twoModels: Post & User;

export const builder = () => Post.query().populate('Owner');
export const rows = async () => Post.query().populate('Owner');
export const row = async () => Post.query().populate('Owner').first();
export const tagRows = async () => Post.query().populate('Tags');
