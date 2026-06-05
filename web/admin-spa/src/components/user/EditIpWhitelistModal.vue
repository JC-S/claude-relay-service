<template>
  <div
    v-if="show"
    class="fixed inset-0 z-50 h-full w-full overflow-y-auto bg-gray-600 bg-opacity-50"
  >
    <div
      class="relative top-20 mx-auto w-[768px] max-w-4xl rounded-md border bg-white p-5 shadow-lg"
    >
      <div class="mt-3">
        <div class="mb-4 flex items-center justify-between">
          <h3 class="text-lg font-medium text-gray-900">Edit IP Whitelist</h3>
          <button class="text-gray-400 hover:text-gray-600" @click="emit('close')">
            <svg class="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                d="M6 18L18 6M6 6l12 12"
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
              />
            </svg>
          </button>
        </div>

        <p class="mb-4 text-sm text-gray-500">
          Configure which IP addresses can use this API key. This does not affect your dashboard
          login.
        </p>

        <form class="space-y-4" @submit.prevent="handleSubmit">
          <div v-if="apiKey">
            <label class="block text-sm font-medium text-gray-700">API Key</label>
            <p class="mt-1 text-sm text-gray-900">{{ apiKey.name }}</p>
          </div>

          <div class="flex items-start">
            <div class="flex h-5 items-center">
              <input
                id="enableIpWhitelist"
                v-model="form.enableIpWhitelist"
                class="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                :disabled="loading"
                type="checkbox"
              />
            </div>
            <div class="ml-3 text-sm">
              <label class="font-medium text-gray-700" for="enableIpWhitelist">
                Enable IP whitelist
              </label>
              <p class="text-gray-500">
                When enabled, only requests from listed IPs or CIDR ranges are allowed.
              </p>
            </div>
          </div>

          <div>
            <label class="block text-sm font-medium text-gray-700" for="ipWhitelistInput">
              Allowed IPs / CIDRs
            </label>
            <textarea
              id="ipWhitelistInput"
              v-model="form.ipWhitelistInput"
              class="mt-1 block w-full rounded-md border-gray-300 font-mono shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
              :disabled="loading"
              :placeholder="placeholderText"
              rows="6"
            ></textarea>
            <p class="mt-1 text-xs text-gray-500">
              Separate entries by new lines, commas, spaces, or semicolons. IPv4, IPv6, and CIDR are
              supported.
            </p>
          </div>

          <div v-if="error" class="rounded-md border border-red-200 bg-red-50 p-3">
            <div class="flex">
              <div class="flex-shrink-0">
                <svg class="h-5 w-5 text-red-400" fill="currentColor" viewBox="0 0 20 20">
                  <path
                    clip-rule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                    fill-rule="evenodd"
                  />
                </svg>
              </div>
              <div class="ml-3">
                <p class="text-sm text-red-700">{{ error }}</p>
              </div>
            </div>
          </div>

          <div class="flex justify-end space-x-3 pt-4">
            <button
              class="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50"
              :disabled="loading"
              type="button"
              @click="emit('close')"
            >
              Cancel
            </button>
            <button
              class="rounded-md border border-transparent bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="loading"
              type="submit"
            >
              <span v-if="loading" class="flex items-center">
                <svg
                  class="-ml-1 mr-2 h-4 w-4 animate-spin text-white"
                  fill="none"
                  viewBox="0 0 24 24"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <circle
                    class="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    stroke-width="4"
                  ></circle>
                  <path
                    class="opacity-75"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    fill="currentColor"
                  ></path>
                </svg>
                Saving...
              </span>
              <span v-else>Save</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref, watch } from 'vue'
import { useUserStore } from '@/stores/user'
import { parseIpWhitelistInput, showToast } from '@/utils/tools'

const props = defineProps({
  show: {
    type: Boolean,
    default: false
  },
  apiKey: {
    type: Object,
    default: null
  }
})

const emit = defineEmits(['close', 'saved'])

const userStore = useUserStore()

const loading = ref(false)
const error = ref('')
const form = reactive({
  enableIpWhitelist: false,
  ipWhitelistInput: ''
})

const placeholderText = 'One per line, for example:\n203.0.113.10\n203.0.113.0/24'

watch(
  () => [props.show, props.apiKey],
  () => {
    if (!props.show || !props.apiKey) {
      return
    }

    form.enableIpWhitelist =
      props.apiKey.enableIpWhitelist === true || props.apiKey.enableIpWhitelist === 'true'
    form.ipWhitelistInput = Array.isArray(props.apiKey.ipWhitelist)
      ? props.apiKey.ipWhitelist.join('\n')
      : ''
    error.value = ''
  },
  { immediate: true }
)

const handleSubmit = async () => {
  const entries = parseIpWhitelistInput(form.ipWhitelistInput)
  if (form.enableIpWhitelist && entries.length === 0) {
    error.value = 'At least one IP or CIDR is required when IP whitelist is enabled'
    return
  }

  loading.value = true
  error.value = ''

  try {
    const result = await userStore.updateApiKey(props.apiKey.id, {
      enableIpWhitelist: form.enableIpWhitelist,
      ipWhitelist: entries
    })

    if (result.success) {
      showToast('IP whitelist updated successfully', 'success')
      emit('saved')
      emit('close')
    } else {
      error.value = result.message || 'Failed to update IP whitelist'
    }
  } catch (err) {
    error.value = err.response?.data?.message || err.message || 'Failed to update IP whitelist'
  } finally {
    loading.value = false
  }
}
</script>
