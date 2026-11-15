import { Post, Tag, User } from './models.js';

export async function positive01ForOfAll(): Promise<string[]> {
  const out: string[] = [];
  const posts = await Post.all();
  for (const post of posts) {
    out.push(post.Owner.Value?.Name ?? ''); // expect ORM101
  }
  return out;
}

export async function positive02InlineWhere(): Promise<number> {
  let n = 0;
  for (const post of await Post.where('Published', true)) {
    n += post.Tags.length; // expect ORM101
  }
  return n;
}

export async function positive03Map(): Promise<Array<string | undefined>> {
  const posts = await Post.where('Published', true);
  return posts.map((p) => p.Owner.Value?.Name); // expect ORM101
}

export async function positive04PromiseAll(): Promise<Array<string | undefined>> {
  const posts = await Post.all();
  return Promise.all(posts.map(async (p) => Promise.resolve(p.Owner.Value?.Name))); // expect ORM101
}

export async function positive05OtherRelation(): Promise<number> {
  let n = 0;
  const posts = await Post.query().populate('Owner');
  posts.forEach((p) => {
    n += p.Tags.length; // expect ORM101
  });
  return n;
}

export async function positive06Nested(): Promise<string[]> {
  const posts = await Post.query().populate('Owner');
  return posts.map((p) => p.Owner.Value?.Company.Value?.Name ?? ''); // expect ORM101
}

export async function positive07FilteredAlias(): Promise<string[]> {
  const posts = await Post.all();
  const published = posts.filter((p) => p.Published);
  const out: string[] = [];
  for (const p of published) {
    out.push(p.Owner.Value?.Name ?? ''); // expect ORM101
  }
  return out;
}

export async function positive08RestElement(): Promise<string[]> {
  const [, ...rest] = await Post.all();
  return rest.map((p) => p.Owner.Value?.Name ?? ''); // expect ORM101
}

export async function positive09IgnoreWithoutReason(): Promise<string[]> {
  const posts = await Post.all();
  const out: string[] = [];
  // spinajs-orm-ignore ORM101:
  for (const p of posts) {
    out.push(p.Owner.Value?.Name ?? ''); // expect ORM101
  }
  return out;
}

export async function positive10While(ids: number[]): Promise<User[]> {
  const out: User[] = [];
  let i = 0;
  while (i < ids.length) {
    out.push(await User.get(ids[i])); // expect ORM102
    i++;
  }
  return out;
}

export async function positive11RelationPopulate(): Promise<number> {
  let n = 0;
  for (const p of await Post.all()) {
    await p.Tags.populate(); // expect ORM102
    n += p.Tags.length;
  }
  return n;
}

export async function positive12MapAsync(ids: number[]): Promise<User[]> {
  return Promise.all(ids.map(async (id) => await User.where('Id', id).firstOrFail())); // expect ORM102
}

export async function negative01Populated(): Promise<string[]> {
  const posts = await Post.query().populate('Owner');
  const out: string[] = [];
  for (const p of posts) out.push(p.Owner.Value?.Name ?? '');
  return out;
}

export async function negative02NestedPopulate(): Promise<string[]> {
  const posts = await Post.query().populate('Owner.Company');
  return posts.map((p) => p.Owner.Value?.Company.Value?.Name ?? '');
}

export async function negative03OutsideLoop(): Promise<string | undefined> {
  const post = await Post.get(1);
  return post.Owner.Value?.Name;
}

export function negative04Parameter(posts: Post[]): string[] {
  return posts.map((p) => p.Owner.Value?.Name ?? '');
}

export async function negative05IgnoreWithReason(): Promise<string[]> {
  const posts = await Post.all();
  const out: string[] = [];
  // spinajs-orm-ignore ORM101: the caller preloads every owner into the identity map
  for (const p of posts) {
    out.push(p.Owner.Value?.Name ?? '');
  }
  return out;
}

export async function negative06IgnoreLoopQuery(ids: number[]): Promise<User[]> {
  const out: User[] = [];
  // spinajs-orm-ignore ORM102: ids never holds more than three entries
  for (const id of ids) {
    out.push(await User.get(id));
  }
  return out;
}

export async function negative07StreamPopulated(): Promise<string[]> {
  const out: string[] = [];
  for await (const p of Post.query().populate('Owner').stream()) {
    out.push(p.Owner.Value?.Name ?? '');
  }
  return out;
}

export async function negative08ColumnsOnly(): Promise<string[]> {
  const posts = await Post.all();
  return posts.map((p) => p.Title);
}

export async function negative09PopulatedFlag(): Promise<number> {
  const posts = await Post.all();
  return posts.filter((p) => p.Owner.Populated).length;
}

export async function negative10BuilderVariable(): Promise<string[]> {
  const query = Post.query();
  query.populate('Owner');
  const posts = await query;
  return posts.map((p) => p.Owner.Value?.Name ?? '');
}

export async function negative11QueryInLoopHeader(): Promise<string[]> {
  const out: string[] = [];
  for (const p of await Post.where('Published', true)) out.push(p.Title);
  return out;
}

export async function negative12WriteInLoop(): Promise<void> {
  const posts = await Post.all();
  for (const p of posts) {
    p.Title = p.Title.trim();
    await p.update();
  }
}

export async function negative13RelationMutators(tag: Tag, owner: User): Promise<void> {
  const posts = await Post.all();
  for (const p of posts) {
    p.Tags.add(tag);
    p.Tags.remove((t) => t.Id === tag.Id);
    p.Tags.set([tag]);
    p.Tags.empty();
    p.Owner.attach(owner);
    p.Owner.detach();
  }
}
