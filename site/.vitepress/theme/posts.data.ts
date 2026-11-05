import { allPosts, isPublished } from "../blog";

export interface Post {
  url: string;
  title: string;
  description: string;
  date: string;
}

declare const data: Post[];
export { data };

export default {
  watch: ["../../../docs/blog/*.md"],
  load(): Post[] {
    return allPosts()
      .filter((p) => isPublished(p))
      .map((p) => ({
        url: `/blog/${p.file.replace(/\.md$/, ".html")}`,
        title: p.title,
        description: p.description,
        date: p.date,
      }));
  },
};
