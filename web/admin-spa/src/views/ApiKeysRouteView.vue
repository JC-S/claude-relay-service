<template>
  <!-- 按角色渲染：v2 账号看受限的子 key 视图，管理员看完整管理视图 -->
  <V2ApiKeysView v-if="isV2Role" />
  <ApiKeysView v-else />
</template>

<script setup>
import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import ApiKeysView from '@/views/ApiKeysView.vue'
import V2ApiKeysView from '@/views/V2ApiKeysView.vue'

const authStore = useAuthStore()
const isV2Role = computed(() => authStore.userRole === 'v2')
</script>
