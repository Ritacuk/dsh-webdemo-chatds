window.__ModuleLoader__.load({
  id: 'dsh-webdemo-chatds-agent-side-chat',
  factory(require) {
    const React = require('react')
    const kind = 'chatds-agent-side-chat'
    const id = 'dsh-webdemo-chatds-agent-side-chat'
    return {
      inject: ['slots', 'sidebarRightTabs', 'theme'],
      apply(ctx) {
        function SideChat({ parentSession }) {
          const ref = React.useRef(null)
          React.useEffect(() => {
            const iframe = ref.current
            if (!iframe) return
            const update = () => iframe.contentWindow?.postMessage({
              type: 'chatds:theme', mode: ctx.theme.getTheme().active.colorScheme,
            }, location.origin)
            const off = ctx.on('theme/change', update)
            iframe.addEventListener('load', update)
            update()
            return () => { off(); iframe.removeEventListener('load', update) }
          }, [])
          return React.createElement('iframe', {
            ref, title: 'Agent Side Chat',
            src: '/chat-workspace-sidecar?parent=' + encodeURIComponent(parentSession),
            allow: 'clipboard-write; microphone',
            style: { border: 0, width: '100%', height: '100%', display: 'block' },
          })
        }
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id, kind, title: () => 'Agent Side Chat', keepMounted: true,
          guide: [{ id: kind, order: 80, title: () => 'Agent Side Chat', description: () => '选择父任务的检查点并打开旁聊' }],
        }), 'ChatDS Side Chat tab type')
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab', key: id,
          inject: (sessionId) => ({ parentSession: sessionId }),
        }, SideChat))
      },
    }
  },
})
