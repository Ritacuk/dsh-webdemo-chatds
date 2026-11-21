import { useEffect, useState } from 'react'
import { ImportModal } from './components/session/ImportModal.js'
import { ExportModal } from './components/session/ExportModal.js'
import { useTranslate } from './i18n/index.js'
import { isChineseBrowser, setLocale, useSettings } from './services/settings.js'
import { useIsMobile, useMobileViewport, usePreventPageScroll } from './app/viewport.js'
import { initStore, openSession, reloadSettings, useChatStore } from './store/workspace.js'
import { SearchPanel } from './components/search/SearchPanel.js'
import { closeSearchPanel } from './components/search/searchPanelState.js'
import { SessionView } from './components/session/SessionView.js'
import { parentSession, SidecarContext } from './components/session/SidecarContext.js'
import { MobileHeader } from './components/session/MobileHeader.js'
import { Welcome } from './components/session/Welcome.js'
import { Toast } from './components/base/Toast.js'
import { Button } from './components/base/Button.js'
import { setupTheme } from './app/theme.js'
import { ensureKatex } from './services/markdown/katex.js'
import { checkBudgetReminder } from './services/budget.js'
import { CollapsedSider } from './components/sider/CollapsedSider.js'
import { closeMobileSider } from './components/sider/mobileSiderState.js'
import { MobileSider, Sider } from './components/sider/Sider.js'
import styles from './app/App.module.css'

// P2: 设置页(SettingsDialog / settingsDialogState)、附件上传通知、朗读、
// 历史导入导出与本地持久化(bindChatPersistence)暂不移植。
// 主题同步与 KaTeX 预热由 App 挂载时完成(demo 在 main.tsx 里做)。
// 顶层结构保持 demo 的 Sider + (activeId==null ? Welcome : SessionView) 布局;
// activeId 经 useChatStore 监听,会话打开由 Sider/SessionItem 调 openSession。

export const App = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const locale = useSettings((state) => state.locale)
  const language = useChatStore((state) => state.settings?.interfaceLanguage)
  // 移动端侧边栏以独立抽屉管理开合状态
  const siderCollapsed = useSettings((state) => state.siderCollapsed) && !isMobile
  const ready = useChatStore((state) => state.ready)
  const initError = useChatStore((state) => state.initError)
  const session = useChatStore((state) =>
    state.activeId !== null && Object.hasOwn(state.sessionCache, state.activeId)
      ? state.sessionCache[state.activeId]
      : undefined
  )
  const sessionLoadError = useChatStore((state) =>
    state.activeId === null ? false : state.sessionLoadErrors[state.activeId] === true
  )
  const frameRef = useMobileViewport(isMobile)
  const streaming = useChatStore((state) =>
    state.activeId === null ? false : Object.hasOwn(state.streaming, state.activeId)
  )
  const activeId = useChatStore((state) => state.activeId)
  const [dataAction, setDataAction] = useState<'import' | 'export' | null>(null)
  const settledTick = useChatStore((state) => state.settledTick)

  usePreventPageScroll(isMobile)

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (window.parent === window || event.source !== window.parent || event.origin !== location.origin) return
      if (event.data?.type === 'chatds:request-active-session') {
        window.parent.postMessage({ type: 'chatds:active-session', id: useChatStore.getState().activeId }, location.origin)
      }
      if (event.data?.type === 'chatds:data' && ['import', 'export'].includes(event.data.action)) setDataAction(event.data.action)
    }
    window.addEventListener('message', receive)
    if (window.parent !== window) window.parent.postMessage({ type: 'chatds:ready' }, location.origin)
    return () => window.removeEventListener('message', receive)
  }, [])

  useEffect(() => {
    if (window.parent !== window) window.parent.postMessage({ type: 'chatds:active-session', id: activeId }, location.origin)
  }, [activeId])

  useEffect(() => {
    if (language) setLocale(language === 'browser' ? (isChineseBrowser() ? 'zh-CN' : 'en-US') : language)
  }, [language])

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  // R8:预算提醒(回合结束/启动/设置变化时检查;阈值每天一次)
  useEffect(() => {
    void checkBudgetReminder()
  }, [settledTick])

  useEffect(() => {
    const stopTheme = setupTheme()
    const settingsChannel = new BroadcastChannel('chatds:settings')
    settingsChannel.onmessage = () => { void reloadSettings().catch(() => {}) }
    ensureKatex()
    return () => { stopTheme(); settingsChannel.close() }
  }, [])

  // 搜索结果面板只属于当前会话
  useEffect(closeSearchPanel, [activeId])
  // 移动端选中会话、切换布局后收起抽屉
  useEffect(closeMobileSider, [activeId, isMobile])

  const sideChat = parentSession !== null
  const sessionView = session ? <SessionView session={session} streaming={streaming} siderCollapsed={false} embedded /> : null

  return (
    <>
      <div ref={frameRef} className={styles.frame}>
        {sideChat ? null : isMobile ? <MobileSider onData={setDataAction} /> : siderCollapsed ? null : <Sider onData={setDataAction} />}
        <main className={styles.main}>
          <div className={styles.content}>
            {!sideChat && siderCollapsed ? <CollapsedSider /> : null}
            {sideChat ? <SidecarContext streaming={streaming}>{sessionView}</SidecarContext> : !ready || (activeId !== null && !session) ? (
              <div className={styles.loadingView}>
                {isMobile ? <MobileHeader /> : null}
                <div className={styles.loadingState} role="status" aria-live="polite">
                  <span>
                    {(!ready ? initError : sessionLoadError)
                      ? t(!ready ? 'sessionListLoadFailed' : 'sessionLoadFailed')
                      : t('sessionLoading')}
                  </span>
                  {(!ready ? initError : sessionLoadError) ? (
                    <Button
                      variant="outlined"
                      size="m"
                      onClick={() => {
                        if (!ready) {
                          void initStore()
                        } else if (activeId !== null) {
                          void openSession(activeId)
                        }
                      }}
                    >
                      {t('retry')}
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : session ? (
              <SessionView
                session={session}
                streaming={streaming}
                siderCollapsed={siderCollapsed}
              />
            ) : (
              <Welcome />
            )}
          </div>
        </main>
        <SearchPanel />
      </div>
      {dataAction === 'import' && <ImportModal onClose={() => setDataAction(null)} />}
      {dataAction === 'export' && <ExportModal onClose={() => setDataAction(null)} />}
      <Toast />
    </>
  )
}
