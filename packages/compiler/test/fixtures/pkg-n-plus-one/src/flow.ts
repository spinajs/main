import { Post } from './models.js';

export async function scoped(): Promise<void> {
  const posts = await Post.query()
    .populate('Owner', function () {
      this.populate('Company');
    })
    .accessible();
  const first = await Post.where('Id', 1).unscoped().first();
  const [head, ...tail] = posts;
  void [first, head, tail];
}

export async function builder(): Promise<void> {
  const query = Post.query();
  query.populate('Tags');
  const posts = await query;
  void posts;
}

export async function loops(): Promise<number> {
  const posts = await Post.all();
  for (const p of posts) void p;
  posts.forEach((q) => void q);
  await Promise.all(posts.map(async (r) => Promise.resolve(r)));
  return posts.reduce((n, s) => n + s.Id, 0);
}
