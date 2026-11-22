<template>
  <div class="draft-review">
    <p>视频会按下面的片段描述生成。请对照分镜里的动作和结果，看看有没有漏掉你想拍的画面。</p>
    <dl>
      <template v-if="action"><dt>动作</dt><dd>{{ action }}</dd></template>
      <template v-if="result"><dt>结果</dt><dd>{{ result }}</dd></template>
      <dt>用于生成的片段描述</dt><dd>{{ draft }}</dd>
    </dl>
  </div>
</template>

<script setup>
defineProps({ action: String, result: String, draft: { type: String, required: true } })
</script>

<style scoped>
.draft-review { max-height: 55vh; overflow: auto; overflow-wrap: anywhere; }
p, dl { margin: 0; }
dt { margin-top: 0.8em; font-weight: 600; }
dd { margin: 0.2em 0 0; white-space: pre-wrap; }
</style>
