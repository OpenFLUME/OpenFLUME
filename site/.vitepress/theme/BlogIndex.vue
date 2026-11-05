<script setup lang="ts">
import { withBase } from "vitepress";
import { data as posts } from "./posts.data";
</script>

<template>
  <ul class="blog-index">
    <li v-for="post in posts" :key="post.url">
      <span class="blog-index__date">{{ post.date }}</span>
      <a :href="withBase(post.url)">{{ post.title }}</a>
      <p v-if="post.description">{{ post.description }}</p>
    </li>
  </ul>
  <p v-if="posts.length === 0">No posts yet.</p>
</template>

<style scoped>
.blog-index {
  list-style: none;
  padding-left: 0;
}
.blog-index li {
  margin: 0 0 1.4rem;
}
.blog-index__date {
  display: block;
  font-size: 0.85rem;
  color: var(--vp-c-text-2);
}
.blog-index a {
  font-weight: 600;
  font-size: 1.1rem;
}
.blog-index p {
  margin: 0.25rem 0 0;
  color: var(--vp-c-text-2);
}
</style>
