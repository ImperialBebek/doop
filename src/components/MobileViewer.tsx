import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ElementComment, Frame } from '../../shared/types'
import { canvasPages, pageFrames } from '../../shared/pages'
import { readingOrder } from '../../shared/frameOrder'
import { elementIdSelector } from '../../shared/elementId'
import { canCommentOpenCanvas, useStore } from '../lib/store'
import { isCanvasElement } from '../lib/drawing'
import { FRAME_BOOTSTRAP } from '../lib/frameRuntime'
import { api } from '../lib/api'
import { isResidentLimit } from './TeamAllowance'
import { navigate } from '../lib/navigate'
import { posthog } from '../lib/posthog'
import { useT } from '../lib/i18n'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { Pressable } from './ui/pressable'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu'
import { ArrowLeftIcon, ChevronDownIcon, XIcon } from './ui/icons'
import { CommentComposer, CommentThread } from './CommentPopovers'

/**
 * The canvas on a phone: one frame at a time, swiped through like photos in a
 * gallery, with element comments. Nothing else of the editor is here, and on
 * purpose: mobile Safari backs every GPU layer of the scaled canvas at full
 * size and kills the tab past 2 GB, so the phone gets one plain iframe (the
 * frame runtime, for finding elements) under a transparent tap layer.
 */

type Rect = { x: number; y: number; width: number; height: number }
interface Hit {
  selector: string
  elementId?: string
  snippet: string
  rect: Rect
  point: { x: number; y: number }
}

/* a swipe: mostly sideways, and far enough to mean it */
const SWIPE_PX = 56

export function MobileViewer() {
  const t = useT()
  const canvas = useStore((s) => s.canvas)
  const activePageId = useStore((s) => s.activePageId)
  const canComment = useStore(canCommentOpenCanvas)
  const pages = canvas ? canvasPages(canvas) : []
  const pageId = activePageId ?? pages[0]?.id ?? null
  const frames =
    canvas && pageId
      ? readingOrder(pageFrames(canvas, pageId).filter((f) => !f.hidden && !isCanvasElement(f.html)))
      : []
  const [indexByPage, setIndexByPage] = useState<Record<string, number>>({})
  const index = Math.min(pageId ? (indexByPage[pageId] ?? 0) : 0, Math.max(0, frames.length - 1))
  const frame = frames[index]
  const go = (dir: -1 | 1) => {
    if (!pageId) return
    const next = index + dir
    if (next < 0 || next >= frames.length) return
    setIndexByPage((prev) => ({ ...prev, [pageId]: next }))
  }

  return (
    <div className="fixed inset-x-0 bottom-0 top-[var(--app-inset,0px)] flex flex-col bg-canvas">
      <header className="flex h-14 flex-none items-center gap-2 border-b border-line-soft bg-surface px-2 pt-[env(safe-area-inset-top)]">
        <Button variant="bare" size="icon" aria-label={t('canvas.backToCanvases')} onClick={() => navigate('/')}>
          <ArrowLeftIcon />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-body font-medium text-ink">{canvas?.name ?? ''}</div>
          {pages.length > 1 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Pressable layout="inline" className="max-w-full gap-1 text-caption text-ink-soft">
                  <span className="truncate">{pages.find((p) => p.id === pageId)?.name}</span>
                  <ChevronDownIcon size="rail" className="shrink-0" />
                </Pressable>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" width="md" className="max-h-[60vh] overflow-y-auto">
                {pages.map((p) => (
                  <DropdownMenuItem key={p.id} onSelect={() => useStore.getState().setActivePage(p.id)}>
                    {p.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
        {frames.length > 0 && (
          <span className="flex-none pr-2 font-mono text-label text-ink-faint tabular-nums">
            {index + 1}/{frames.length}
          </span>
        )}
      </header>
      {frame ? (
        <FrameSlide key={frame.id} frame={frame} canComment={canComment} onSwipe={go} />
      ) : (
        <div className="grid flex-1 place-items-center px-6 text-center text-body text-ink-faint">
          {canvas ? t('stage.mobileNoFrames') : null}
        </div>
      )}
      {frame && (
        <div className="flex-none truncate border-t border-line-soft bg-surface px-4 py-2 pb-[calc(8px+env(safe-area-inset-bottom))] text-caption text-ink-soft">
          {frame.name}
        </div>
      )}
    </div>
  )
}

/** One frame, its width filling the screen and scrolled down when it is
 *  tall, with its comment pins; a tap picks the element under it to comment on. */
function FrameSlide({
  frame,
  canComment,
  onSwipe,
}: {
  frame: Frame
  canComment: boolean
  onSwipe: (dir: -1 | 1) => void
}) {
  const t = useT()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [ready, setReady] = useState(false)
  const [shown, setShown] = useState<string | null>(null)
  const [hit, setHit] = useState<Hit | null>(null)
  const [openThread, setOpenThread] = useState<string | null>(null)
  const [pins, setPins] = useState<Record<string, { x: number; y: number } | null>>({})
  const scale = width ? width / frame.width : 0

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  /* the runtime answers on the window, each reply matched to its request */
  const requests = useRef(new Map<string, (data: Record<string, unknown>) => void>())
  const ask = useCallback((type: string, payload: Record<string, unknown>, answer = `${type}-result`) => {
    const win = iframeRef.current?.contentWindow
    if (!win) return Promise.resolve(null)
    const reqId = `${type}:${Math.random().toString(36).slice(2)}`
    return new Promise<Record<string, unknown> | null>((resolve) => {
      requests.current.set(`${answer}|${reqId}`, resolve)
      win.postMessage({ type, reqId, ...payload }, '*')
      window.setTimeout(() => {
        if (requests.current.delete(`${answer}|${reqId}`)) resolve(null)
      }, 4000)
    })
  }, [])
  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      const win = iframeRef.current?.contentWindow
      if (!win || ev.source !== win || !ev.data || typeof ev.data !== 'object') return
      const data = ev.data as Record<string, unknown>
      if (data.type === 'doop:frame-ready') return setReady(true)
      const key = `${String(data.type)}|${String(data.reqId)}`
      const resolve = requests.current.get(key)
      if (resolve) {
        requests.current.delete(key)
        resolve(data)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  /* the design, sent again whenever someone edits it */
  useEffect(() => {
    if (!ready) return
    let live = true
    void ask('doop:html', { html: frame.html }).then(() => live && setShown(frame.html))
    return () => {
      live = false
    }
  }, [ready, frame.html, ask])

  const comments = useStore((s) => s.comments)
  const threads = useMemo(() => {
    const roots = comments.filter((c) => c.frameId === frame.id && !c.parentId && !c.resolvedAt)
    return roots.map((root): [ElementComment, ...ElementComment[]] => [
      root,
      ...comments.filter((c) => c.parentId === root.id).sort((a, b) => a.at - b.at),
    ])
  }, [comments, frame.id])

  /* each pin on its element as the design now lays it out */
  useEffect(() => {
    if (!shown) return
    let live = true
    void Promise.all(
      threads.map(async ([c]) => {
        const fallback = c.x !== undefined && c.y !== undefined ? { x: c.x, y: c.y } : null
        if (!c.elementId) return [c.id, fallback] as const
        const reply = await ask('doop:locate', { selector: elementIdSelector(c.elementId) }, 'doop:located')
        const rect = reply?.rect as Rect | null | undefined
        if (!rect) return [c.id, fallback] as const
        const origin = c.elementOrigin
        const offset = origin && fallback ? { x: fallback.x - origin.x, y: fallback.y - origin.y } : { x: 0, y: 0 }
        return [c.id, { x: rect.x + offset.x, y: rect.y + offset.y }] as const
      }),
    ).then((entries) => live && setPins(Object.fromEntries(entries)))
    return () => {
      live = false
    }
  }, [shown, threads, ask])

  /* a tap that did not move picks the element under it; a sideways swipe
     turns the page; anything else is the scroll's */
  const press = useRef<{ x: number; y: number; at: number } | null>(null)
  function onTouchStart(e: React.TouchEvent) {
    const touch = e.touches[0]
    press.current = e.touches.length === 1 && touch ? { x: touch.clientX, y: touch.clientY, at: Date.now() } : null
  }
  function onTouchEnd(e: React.TouchEvent) {
    const start = press.current
    const touch = e.changedTouches[0]
    press.current = null
    if (!start || !touch) return
    const dx = touch.clientX - start.x
    const dy = touch.clientY - start.y
    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) return onSwipe(dx < 0 ? 1 : -1)
    if (Math.abs(dx) + Math.abs(dy) > 8 || Date.now() - start.at > 600) return
    if (!canComment || !scale || !shown) return
    const box = e.currentTarget.getBoundingClientRect()
    const point = { x: (touch.clientX - box.left) / scale, y: (touch.clientY - box.top) / scale }
    setOpenThread(null)
    void ask('doop:probe', { x: point.x, y: point.y, grouped: false, selected: [] }).then((reply) => {
      const found = reply?.hit as Omit<Hit, 'point'> | null | undefined
      setHit(found ? { ...found, point } : null)
    })
  }

  function submit(text: string, mentions: string[]) {
    if (!hit) return
    api
      .addComment(frame.id, {
        selector: hit.selector,
        ...(hit.elementId ? { elementId: hit.elementId } : {}),
        snippet: hit.snippet,
        text,
        mentions,
        x: hit.point.x,
        y: hit.point.y,
        elementOrigin: { x: hit.rect.x, y: hit.rect.y },
      })
      .then(() => posthog.capture('element_comment_created', { via: 'mobile' }))
      .catch((err) => {
        if (isResidentLimit(err)) useStore.getState().setLimitWall(true)
        else console.error(err)
      })
    setHit(null)
  }

  const thread = threads.find(([c]) => c.id === openThread)
  return (
    <>
      <div ref={boxRef} className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
        {scale > 0 && (
          <div className="relative bg-white" style={{ width, height: frame.height * scale }}>
            <iframe
              ref={iframeRef}
              title={frame.name}
              sandbox="allow-scripts"
              srcDoc={FRAME_BOOTSTRAP}
              className="pointer-events-none block origin-top-left border-none"
              style={{ width: frame.width, height: frame.height, transform: `scale(${scale})` }}
            />
            {/* takes every touch: the design's own links and scripts never see one */}
            <div className="absolute inset-0" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd} />
            {hit && (
              <div
                className="pointer-events-none absolute rounded-tag bg-brand/10 shadow-[inset_0_0_0_1.5px_var(--brand)]"
                style={{
                  left: hit.rect.x * scale,
                  top: hit.rect.y * scale,
                  width: hit.rect.width * scale,
                  height: hit.rect.height * scale,
                }}
              />
            )}
            {threads.map(([c], i) => {
              const at = pins[c.id]
              if (!at) return null
              return (
                <Pressable
                  key={c.id}
                  layout="inline"
                  aria-label={t('stage.mobileOpenComment')}
                  className={cn(
                    'absolute grid size-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-pill text-label font-medium text-white shadow-float',
                    openThread === c.id ? 'bg-ink' : 'bg-brand',
                  )}
                  style={{ left: at.x * scale, top: at.y * scale }}
                  onClick={() => {
                    setHit(null)
                    setOpenThread(openThread === c.id ? null : c.id)
                  }}
                >
                  {i + 1}
                </Pressable>
              )
            })}
          </div>
        )}
      </div>
      {(hit || thread) && (
        <div className="relative max-h-[55vh] flex-none overflow-y-auto border-t border-line bg-surface p-3 shadow-pop">
          <Button
            variant="bare"
            size="icon-sm"
            className="absolute top-2 right-2 z-10"
            aria-label={t('common.close')}
            onClick={() => {
              setHit(null)
              setOpenThread(null)
            }}
          >
            <XIcon />
          </Button>
          {hit ? (
            <CommentComposer onSubmit={submit} onCancel={() => setHit(null)} />
          ) : thread ? (
            <CommentThread
              thread={thread}
              onReply={(text, mentions) =>
                api.replyComment(thread[0].id, text, mentions).catch((err) => {
                  if (isResidentLimit(err)) useStore.getState().setLimitWall(true)
                  throw err
                })
              }
              onResolve={() => {
                api.resolveComment(thread[0].id).catch(console.error)
                setOpenThread(null)
              }}
              onRetry={(id) => void api.retryComment(id).catch(console.error)}
            />
          ) : null}
        </div>
      )}
    </>
  )
}
