<template>
  <V2RequestDetailsView v-if="isV2Role" />
  <RequestDetailsView v-else />
</template>

<script setup>
import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import RequestDetailsView from '@/views/RequestDetailsView.vue'
import V2RequestDetailsView from '@/views/V2RequestDetailsView.vue'

const authStore = useAuthStore()
const isV2Role = computed(() => authStore.userRole === 'v2')
</script>
