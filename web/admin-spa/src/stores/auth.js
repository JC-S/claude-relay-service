import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import router from '@/router'

import { loginApi, getAuthUserApi, getOemSettingsApi, logoutApi } from '@/utils/http_apis'
import { V2_IMPERSONATION_TOKEN_KEY, V2_IMPERSONATION_USERNAME_KEY } from '@/utils/tools'

export const useAuthStore = defineStore('auth', () => {
  // 状态
  // 🕵️ 模拟登录态（管理员切换到 v2 账号视图）：v2 token 只进 sessionStorage（按标签页隔离、F5 不丢），
  // 管理员 token 始终留在 localStorage，其它标签页不受影响
  const impersonationToken = sessionStorage.getItem(V2_IMPERSONATION_TOKEN_KEY) || ''
  const authToken = ref(impersonationToken || localStorage.getItem('authToken') || '')
  // 路由守卫先于 App.vue 的 checkAuth() 执行，初始 false 会把带 token 的刷新踢去 /login
  const isLoggedIn = ref(!!authToken.value)
  const username = ref(sessionStorage.getItem(V2_IMPERSONATION_USERNAME_KEY) || '')
  const userRole = ref(impersonationToken ? 'v2' : localStorage.getItem('userRole') || '') // 🆕 'admin' | 'v2'
  const isImpersonating = ref(!!impersonationToken)
  const loginError = ref('')
  const loginLoading = ref(false)
  const oemSettings = ref({
    siteName: 'Claude Relay Service',
    siteIcon: '',
    siteIconData: '',
    faviconData: ''
  })
  const oemLoading = ref(true)

  // 计算属性
  const isAuthenticated = computed(() => !!authToken.value && isLoggedIn.value)
  const token = computed(() => authToken.value)
  const user = computed(() => ({ username: username.value, role: userRole.value }))

  // 方法
  async function login(credentials) {
    loginLoading.value = true
    loginError.value = ''

    try {
      const result = await loginApi(credentials)

      if (result.success) {
        // 清掉可能残留的模拟态键，避免旧模拟态影响新登录
        sessionStorage.removeItem(V2_IMPERSONATION_TOKEN_KEY)
        sessionStorage.removeItem(V2_IMPERSONATION_USERNAME_KEY)
        isImpersonating.value = false
        authToken.value = result.token
        username.value = result.username || credentials.username
        userRole.value = result.role || 'admin'
        isLoggedIn.value = true
        localStorage.setItem('authToken', result.token)
        localStorage.setItem('userRole', userRole.value)

        // 🆕 v2 账号登录后只进 API Keys 页面
        await router.push(userRole.value === 'v2' ? '/api-keys' : '/dashboard')
      } else {
        loginError.value = result.message || '登录失败'
      }
    } catch (error) {
      loginError.value = error.message || '登录失败，请检查用户名和密码'
    } finally {
      loginLoading.value = false
    }
  }

  function logout() {
    // 模拟态标记一并清掉（覆盖模拟中点「退出登录」与 verifyToken 失败路径）
    sessionStorage.removeItem(V2_IMPERSONATION_TOKEN_KEY)
    sessionStorage.removeItem(V2_IMPERSONATION_USERNAME_KEY)
    isImpersonating.value = false
    isLoggedIn.value = false
    authToken.value = ''
    username.value = ''
    userRole.value = ''
    localStorage.removeItem('authToken')
    localStorage.removeItem('userRole')
    router.push('/login')
  }

  function checkAuth() {
    if (authToken.value) {
      isLoggedIn.value = true
      // 验证token有效性
      verifyToken()
    }
  }

  async function verifyToken() {
    try {
      const userResult = await getAuthUserApi()
      if (!userResult.success || !userResult.user) {
        // 模拟态：401 已由拦截器自愈接管；非 401 瞬时失败不应销毁 localStorage 里的管理员会话
        if (!isImpersonating.value) logout()
        return
      }
      username.value = userResult.user.username
      userRole.value = userResult.user.role || 'admin'
      // 模拟态下绝不把 'v2' 写进共享 localStorage（其它标签页与退出模拟恢复都依赖它是管理员角色）
      if (!isImpersonating.value) {
        localStorage.setItem('userRole', userRole.value)
      }
    } catch (error) {
      if (!isImpersonating.value) logout()
    }
  }

  // 🕵️ 进入 v2 模拟态：管理员 token 不动（仍在 localStorage），模拟态只进 sessionStorage
  async function enterV2Impersonation({ token: v2Token, username: v2Username }) {
    if (isImpersonating.value) return
    sessionStorage.setItem(V2_IMPERSONATION_TOKEN_KEY, v2Token)
    sessionStorage.setItem(V2_IMPERSONATION_USERNAME_KEY, v2Username || '')
    authToken.value = v2Token
    username.value = v2Username || ''
    userRole.value = 'v2'
    isLoggedIn.value = true
    isImpersonating.value = true
    await router.push('/api-keys').catch(() => {})
  }

  // 🕵️ 退出 v2 模拟态：服务端删除模拟会话是 best-effort，恢复管理员放 finally，绝不卡在模拟态
  async function exitV2Impersonation() {
    if (!isImpersonating.value) return
    try {
      // 此刻拦截器仍取 sessionStorage 的 v2 token，删的正是模拟会话；
      // 若该会话已 401，响应拦截器会就地自愈并整页重载（本函数不再继续）
      await logoutApi()
    } finally {
      sessionStorage.removeItem(V2_IMPERSONATION_TOKEN_KEY)
      sessionStorage.removeItem(V2_IMPERSONATION_USERNAME_KEY)
      isImpersonating.value = false
      authToken.value = localStorage.getItem('authToken') || ''
      userRole.value = localStorage.getItem('userRole') || 'admin'
      username.value = ''
      isLoggedIn.value = !!authToken.value
      await router.push('/api-keys').catch(() => {})
      verifyToken() // 后台校准管理员身份；管理员会话已过期则自然走 logout → 登录页
    }
  }

  async function loadOemSettings() {
    oemLoading.value = true
    try {
      const result = await getOemSettingsApi()
      if (result.success && result.data) {
        oemSettings.value = { ...oemSettings.value, ...result.data }

        if (result.data.siteIconData || result.data.siteIcon) {
          const link = document.querySelector("link[rel*='icon']") || document.createElement('link')
          link.type = 'image/x-icon'
          link.rel = 'shortcut icon'
          link.href = result.data.siteIconData || result.data.siteIcon
          document.getElementsByTagName('head')[0].appendChild(link)
        }

        if (result.data.siteName) {
          document.title = `${result.data.siteName} - 管理后台`
        }
      }
    } catch (error) {
      console.error('加载OEM设置失败:', error)
    } finally {
      oemLoading.value = false
    }
  }

  return {
    // 状态
    isLoggedIn,
    authToken,
    username,
    userRole,
    isImpersonating,
    loginError,
    loginLoading,
    oemSettings,
    oemLoading,

    // 计算属性
    isAuthenticated,
    token,
    user,

    // 方法
    login,
    logout,
    checkAuth,
    enterV2Impersonation,
    exitV2Impersonation,
    loadOemSettings
  }
})
