// +-------------------------------------------------------------------------
//
//   地理智能平台 - 智能对话面板
//
//   文件:       ChatPanel.tsx
//
//   日期:       2026年05月09日
//   作者:       JamesLinYJ
// --------------------------------------------------------------------------

// 模块职责
//
// 承接用户自然语言空间分析输入、任务历史、审批动作和运行 transcript。
// 本文件的本地状态只管理编辑态、展开态和弹窗态，服务端运行事实来自 props。

import { useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { AnimatePresence, LayoutGroup, m, useReducedMotion } from 'framer-motion'
import { LoaderCircle, Pencil, Trash2 } from 'lucide-react'
import type { AgentRuntimeConfig, AgentThreadRecord, ToolDescriptor, UserIntent } from '@geo-agent-platform/shared-types'
import { buildFadeMotion, buildFadeUpMotion, buildListItemVariants, buildListVariants } from '../motion'
import { deriveConversationEntries, type TranscriptEntry } from '../runTranscript'
import { AppIcon } from './AppIcon'
import { Markdown } from './Markdown'

interface ChatPanelProps {
  artifactCount:number; currentRunId?:string; currentThreadId?:string; currentThreadTitle?:string
  runCreatedAt?:string; providerLabel:string; runStatus?:string; query:string; isSubmitting:boolean
  errorMessage?:string; uploadedLayerName?:string; intent?:UserIntent
  sessionThreads:AgentThreadRecord[]; transcriptEntries:ReadonlyArray<TranscriptEntry>
  runtimeConfig?:AgentRuntimeConfig; availableTools?:ToolDescriptor[]
  onQueryChange:(v:string)=>void; onSubmit:()=>void; onNewConversation:()=>void
  onFillSample:(v:string)=>void; onSelectClarification:(v:string,id?:string|null)=>void
  onUseTemplate:()=>void; onUpload:(f:File)=>void; onSelectArtifact:(id:string)=>void
  onSelectTask:(id:string)=>void; onRenameTask:(id:string,t:string)=>void
  onDeleteTask:(id:string)=>void; onResolveApproval:(id:string,ok:boolean)=>void
}
type TaskView='chat'|'summary'|'all'
type TaskDialog={mode:'rename'|'delete';task:AgentThreadRecord}|null
const SAMPLES=['巴黎地铁站 1 公里内有哪些医院','我上传的这些点，哪些在柏林市区里','帮我查一下 Springfield 在哪里']as const

export function ChatPanel(p:ChatPanelProps){
  const{artifactCount,currentRunId,currentThreadId,currentThreadTitle,runCreatedAt,providerLabel,runStatus,query,isSubmitting,errorMessage,uploadedLayerName,intent,sessionThreads,transcriptEntries,runtimeConfig,availableTools=[],onQueryChange,onSubmit,onNewConversation,onFillSample,onSelectClarification,onUseTemplate,onUpload,onSelectArtifact,onSelectTask,onRenameTask,onDeleteTask,onResolveApproval}=p
  const[taskVS,setTaskVS]=useState<{mode:TaskView;bound?:string}>({mode:'chat',bound:currentRunId})
  const[expanded,setExpanded]=useState<string[]>([])
  const[search,setSearch]=useState('')
  const[dialog,setDialog]=useState<TaskDialog>(null)
  const[titleDraft,setTitleDraft]=useState('')
  const[composing,setComposing]=useState(false)
  const triggerRef=useRef<HTMLElement|null>(null)
  const submittingRef=useRef(false)
  const rm=useReducedMotion()??false
  const taskView=taskVS.bound===currentRunId?taskVS.mode:'chat'
  const setTaskView=(m:TaskView)=>setTaskVS({mode:m,bound:currentRunId})
  const toggle=(id:string)=>setExpanded(p=>p.includes(id)?p.filter(x=>x!==id):[...p,id])
  if (!isSubmitting) submittingRef.current = false
  const conv=useMemo(()=>deriveConversationEntries(transcriptEntries,runStatus,availableTools),[availableTools,runStatus,transcriptEntries])
  const hasConv=conv.length>0
  const topic=query.trim()||'新对话'
  const recent=useMemo(()=>sessionThreads.slice(0,4),[sessionThreads])
  const filtered=useMemo(()=>{const kw=search.trim().toLowerCase();if(!kw)return sessionThreads;return sessionThreads.filter(t=>[t.title,t.latestUserQuery,t.historyPreview,t.id].filter(Boolean).some(v=>v!.toLowerCase().includes(kw)))},[sessionThreads,search])
  const taskMode=taskView!=='chat';const showSamples=!isSubmitting&&!hasConv&&!taskMode
  const tasks=taskView==='all'?filtered:recent
  const feedV=buildListVariants(rm,.03,.01)
  const entryV=buildListItemVariants(rm,10)
  const openRename=(t:AgentThreadRecord)=>{triggerRef.current=document.activeElement as HTMLElement|null;setTitleDraft(t.title);setDialog({mode:'rename',task:t})}
  const openDelete=(t:AgentThreadRecord)=>{triggerRef.current=document.activeElement as HTMLElement|null;setDialog({mode:'delete',task:t})}
  const closeDialog=()=>{setDialog(null);setTitleDraft('');requestAnimationFrame(()=>{triggerRef.current?.focus();triggerRef.current=null})}
  const submitRename=()=>{if(dialog?.mode==='rename'&&titleDraft.trim()&&titleDraft.trim()!==dialog.task.title)onRenameTask(dialog.task.id,titleDraft.trim());closeDialog()}
  const submitDelete=()=>{if(dialog?.mode==='delete')onDeleteTask(dialog.task.id);closeDialog()}
  const handleSubmit=(e?:FormEvent)=>{e?.preventDefault();if(submittingRef.current||isSubmitting||composing||!query.trim())return;submittingRef.current=true;onSubmit()}
  const handleKey=(e:KeyboardEvent<HTMLInputElement>)=>{if(e.key==='Enter'&&!e.nativeEvent.isComposing&&!composing){e.preventDefault();handleSubmit()}}

  return(
    <div className="flex flex-col gap-3">
      <LayoutGroup id={currentRunId??currentThreadId??'home'}>
        <m.section className="flex flex-col gap-3 min-h-[clamp(560px,calc(100svh-100px),820px)] p-4 rounded-[28px] glass-strong overflow-clip isolate" layout {...buildFadeUpMotion(rm,0,10)}>
          {/* Header */}
          <m.header className="flex items-center justify-between gap-2" layout>
            <div className="flex items-center gap-1.5">
              <span className="pill pill-active text-xs">聊天</span>
              <span className="pill text-xs">{providerLabel}</span>
            </div>
            <div className="flex items-center gap-1.5">
              {sessionThreads.length>0&&<button className="pill text-xs" onClick={()=>setTaskView(taskView==='chat'?'summary':'chat')}><AppIcon name="history" size={12}/>{taskView==='chat'?`${sessionThreads.length}`:'返回'}</button>}
              <button className="pill text-xs gap-1" onClick={onUseTemplate}><AppIcon name="auto_awesome" size={12}/>模板</button>
              <button className="pill text-xs gap-1" onClick={onNewConversation}><Pencil size={11}/>新建</button>
              <span className={`badge ${runStatus==='running'?'badge-neutral':runStatus==='completed'?'badge-green':runStatus==='failed'?'badge-red':''}`}>{fmtS(runStatus)}</span>
            </div>
          </m.header>

          <AnimatePresence mode="wait" initial={false}>
            {taskMode?(
              <m.section key={`t-${taskView}`} className="flex flex-col flex-1 min-h-0 gap-3" aria-label="任务列表" layout {...buildFadeUpMotion(rm,0,18)}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {(taskView==='all'||currentRunId)&&<button className="text-[15px] font-medium text-[#1c1c1e] bg-transparent border-0 cursor-pointer flex items-center gap-1" onClick={()=>taskView==='all'?setTaskView('summary'):currentRunId&&setTaskView('chat')}><AppIcon name="arrow_back" size={15}/>{taskView==='all'?'最近':'关闭'}</button>}
                    <span className="text-[17px] font-semibold text-[#1c1c1e]">{taskView==='all'?'全部任务':'最近'}</span>
                  </div>
                  <span className="text-[13px] text-[#8e8e93]">{sessionThreads.length}个</span>
                </div>
                {taskView==='all'&&<input className="input" value={search} onChange={e=>setSearch(e.target.value)} placeholder="搜索"/>}
                <m.div className="flex flex-col flex-1 overflow-auto" variants={feedV} initial="hidden" animate="visible" layout>
                  {tasks.length?tasks.map(t=>(
                    <div key={t.id}>
                      <button className={`task-row ${t.id===currentThreadId?'task-row-active':''}`}
                        onClick={()=>{onSelectTask(t.id);setTaskView('chat');setSearch('')}}>
                        <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                          <span className="text-[15px] font-medium text-[#1c1c1e] truncate">{t.title}</span>
                          <span className="text-[13px] text-[#8e8e93] line-clamp-1">{t.historyPreview||t.latestUserQuery||'暂无摘要'}</span>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button className="btn-icon w-7 h-7" aria-label="编辑" onClick={e=>{e.stopPropagation();openRename(t)}}><Pencil size={12}/></button>
                          <button className="btn-icon w-7 h-7 text-[#ff3b30]" aria-label="删除" onClick={e=>{e.stopPropagation();openDelete(t)}}><Trash2 size={12}/></button>
                        </div>
                      </button>
                      <div className="task-divider"/>
                    </div>
                  )):<div className="empty-state"><p>没有找到匹配的任务</p></div>}
                </m.div>
                {taskView==='summary'&&sessionThreads.length>recent.length&&<button className="text-[15px] text-[#1c1c1e] font-medium bg-transparent border-0 cursor-pointer py-1" onClick={()=>setTaskView('all')}>查看全部 {sessionThreads.length} 个</button>}
              </m.section>
            ):(
              <m.div key={`c-${currentRunId??'idle'}`} className="flex flex-col flex-1 min-h-0" layout {...buildFadeMotion(rm)}>
                {/* Thread info */}
                <div className="flex items-center justify-between gap-2 pb-2 mb-1 border-b border-[#00000006]">
                  <div className="flex items-center gap-2 min-w-0">
                    {sessionThreads.length>0&&<button className="text-[13px] text-[#3a3a3c] bg-transparent border-0 cursor-pointer flex items-center gap-1" onClick={()=>setTaskView('summary')}><AppIcon name="history" size={12}/>历史</button>}
                    <span className="text-[13px] font-medium text-[#8e8e93] truncate">{currentThreadTitle ?? (currentRunId ? topic : '新对话')}</span>
                  </div>
                  <div className="flex items-center gap-2 text-[11px] text-[#8e8e93] font-mono"><span>{artifactCount}结果</span><span>{runtimeConfig?.supervisor.approvalInterruptTools.length?'审批':'直连'}</span><span>{conv.filter(e=>e.kind!=='message'||e.role!=='user').length}记录</span></div>
                </div>

                {/* Clarification */}
                {intent?.clarificationRequired&&(
                  <m.div className="mb-3 p-3.5 rounded-[18px] bg-[#ff950010] border border-[#ff950020]" layout {...buildFadeUpMotion(rm,0,8)}>
                    <span className="text-[14px] font-medium text-[#ff9500]">{intent.clarificationQuestion}</span>
                    <div className="flex flex-wrap gap-2 mt-2">{intent.clarificationOptions?.map(o=><button key={o.optionId??o.label} className="text-[13px] h-8 px-3.5 rounded-full font-medium cursor-pointer border-0 bg-[#ff950015] text-[#ff9500] transition-all duration-200 hover:bg-[#ff950025]" disabled={isSubmitting} onClick={()=>onSelectClarification(o.label,o.optionId)}>{o.label}</button>)}</div>
                  </m.div>
                )}

                {/* Error */}
                {errorMessage&&<m.div className="error-bar mb-3" role="alert" layout {...buildFadeUpMotion(rm,0,6)}><span>{errorMessage}</span><button className="btn-ghost btn-sm h-8 text-[13px]" onClick={onSubmit}>重试</button></m.div>}

                {/* Messages */}
                <m.div className="flex flex-col gap-1.5 flex-1 overflow-auto pr-0.5 overscroll-contain scroll-smooth pb-2" aria-label="对话" aria-live="polite" variants={feedV} initial="hidden" animate="visible">
                  {hasConv?<AnimatePresence initial={false}>{conv.map(entry=>entry.kind==='message'?(
                    <m.div key={entry.id} className={`msg-row ${entry.role==='user'?'msg-user-row':'msg-bot-row'}`} layout variants={entryV} initial="hidden" animate="visible" exit="exit">
                      {entry.role==='user'?<div className="msg-user">{entry.body}</div>:<div className="msg-bot"><Markdown>{entry.body}</Markdown></div>}
                      <div className="msg-time">{entry.role==='user'&&<span className="mr-1.5 text-[#3a3a3c]">你</span>}{entry.status==='running'?<span className="badge badge-neutral mr-1">处理中</span>:entry.status==='failed'?<span className="badge badge-red mr-1">失败</span>:null}{fmtTime(entry.timestamp)}</div>
                      {entry.artifactId&&<button className="pill text-xs mt-0.5" onClick={()=>onSelectArtifact(entry.artifactId!)}>在地图中查看</button>}
                    </m.div>
                  ):entry.kind==='command_batch'?(
                    <m.div key={entry.id} className="msg-row msg-bot-row w-full" layout variants={entryV} initial="hidden" animate="visible" exit="exit">
                      <button className="flex items-start gap-3 w-full p-3 rounded-[18px] glass-subtle text-left cursor-pointer border-0" onClick={()=>toggle(entry.id)}>
                        <div className="flex-1 min-w-0"><div className="flex items-center gap-2 text-[11px] text-[#8e8e93] font-mono"><span>{entry.title}</span><span className={`badge ${entry.status==='running'?'badge-neutral':entry.status==='completed'?'badge-green':'badge-red'}`}>{fmtTS(entry.status)}</span></div><p className="text-[14px] text-[#3a3a3c] mt-1">{entry.body}</p></div>
                        <span className={`text-[#8e8e93] transition-transform duration-200 ${expanded.includes(entry.id)?'rotate-90':''}`}><AppIcon name="arrow_back" size={14}/></span>
                      </button>
                      {expanded.includes(entry.id)&&entry.commands&&<m.div className="flex flex-col gap-2 mt-2 ml-4 pl-3 border-l-2 border-[#00000008]" layout {...buildFadeMotion(rm)}>{entry.commands.map(cmd=><div key={cmd.id} className="p-2.5 rounded-[14px] bg-[#00000002]"><div className="flex items-center gap-2 text-[11px] font-mono"><span className="text-[#1c1c1e]">{cmd.title}</span><span className={`badge ${cmd.status==='running'?'badge-neutral':cmd.status==='completed'?'badge-green':'badge-red'}`}>{fmtTS(cmd.status)}</span></div>{cmd.commandText&&<pre className="mt-1.5 p-2.5 rounded-[10px] bg-[#1c1c1e] text-[#34c759] text-[11px] font-mono overflow-auto">{cmd.commandText}</pre>}<Markdown>{cmd.body}</Markdown></div>)}</m.div>}
                    </m.div>
                  ):(
                    <m.div key={entry.id} className="msg-row msg-bot-row w-full" layout variants={entryV} initial="hidden" animate="visible" exit="exit">
                      <div className="msg-bot"><div className="flex items-center gap-2 text-[11px] text-[#8e8e93] font-mono mb-1.5"><span className={`badge ${entry.kind==='approval'?'badge-amber':entry.kind==='error'?'badge-red':'badge-neutral'}`}>{fmtKind(entry.kind)}</span><span className={`badge ${entry.status==='blocked'?'badge-amber':entry.status==='failed'?'badge-red':''}`}>{entry.badge||fmtTS(entry.status)}</span></div><strong className="text-[15px] font-semibold text-[#1c1c1e]">{entry.title}</strong><Markdown>{entry.body}</Markdown>{entry.recoveryNote&&<p className="mt-2 text-[13px] text-[#ff9500] font-medium">恢复说明：{entry.recoveryNote}</p>}</div>
                      {entry.kind==='artifact'&&entry.artifactId&&<button className="pill text-xs mt-1" onClick={()=>onSelectArtifact(entry.artifactId!)}>在地图中查看</button>}
                      {entry.kind==='approval'&&entry.approvalId&&<div className="flex gap-2 mt-1.5"><button className="btn btn-primary btn-sm" onClick={()=>onResolveApproval(entry.approvalId!,true)}>批准</button><button className="btn btn-ghost btn-sm" onClick={()=>onResolveApproval(entry.approvalId!,false)}>拒绝</button></div>}
                    </m.div>
                  ))}</AnimatePresence>:isSubmitting?(
                    <div className="flex items-center gap-3 py-4 px-1"><div className="msg-bot"><div className="typing-dots"><div className="typing-dot"/><div className="typing-dot"/><div className="typing-dot"/></div></div></div>
                  ):(
                    <m.div className="empty-state flex-1" layout {...buildFadeUpMotion(rm,0,12)}>
                      <div className="empty-state-icon"><AppIcon name="auto_awesome" size={24}/></div>
                      <h3>准备开始</h3><p>描述想查的区域、对象或空间关系</p>
                    </m.div>
                  )}
                </m.div>
              </m.div>
            )}
          </AnimatePresence>

          {/* Footer */}
          <div className="flex items-center justify-between text-[11px] text-[#8e8e93] font-mono">{runCreatedAt&&runStatus==='running'&&<span>运行中 {fmtElapsed(runCreatedAt)}</span>}<span className="ml-auto">{uploadedLayerName?`已接入：${uploadedLayerName}`:'描述你的空间分析需求，按回车发送'}</span></div>

          {/* Composer (iMessage-style) */}
          <m.form className="composer-bar" layout onSubmit={handleSubmit} {...buildFadeUpMotion(rm,.02,10)}>
            <label className="btn-icon shrink-0" htmlFor="fu"><AppIcon name="attach_file" size={20}/></label>
            <input id="fu" type="file" hidden accept=".geojson,.json,.gpkg" onChange={e=>{const f=e.target.files?.[0];if(f)onUpload(f);e.target.value=''}}/>
            <input id="qi" className="composer-input" value={query} onChange={e=>onQueryChange(e.target.value)}
              onCompositionStart={()=>setComposing(true)} onCompositionEnd={()=>setComposing(false)}
              onKeyDown={handleKey} placeholder="描述空间分析需求…" autoComplete="off"/>
            <button type="submit" className="send-btn" disabled={isSubmitting||!query.trim()} aria-label="发送">
              {isSubmitting?<LoaderCircle size={18} className="animate-spin"/>:<AppIcon name="send" size={17}/>}
            </button>
          </m.form>
        </m.section>
      </LayoutGroup>

      {/* Samples */}
      {showSamples&&<m.div className="flex flex-wrap gap-2 p-3 rounded-[22px] glass-subtle" {...buildFadeUpMotion(rm,.06,8)}>{SAMPLES.map(s=><button key={s} className="pill text-xs" onClick={()=>onFillSample(s)}>{s}</button>)}</m.div>}

      {/* Dialog (iOS Alert) */}
      <AnimatePresence>{dialog&&<m.div className="alert-overlay" onClick={closeDialog} {...buildFadeMotion(rm)}>
        <m.div className="alert" onClick={e=>e.stopPropagation()} onKeyDown={e=>e.key==='Escape'&&closeDialog()} tabIndex={-1} role="dialog" aria-modal="true" {...buildFadeUpMotion(rm,0,12)}>
          {dialog.mode==='rename'?<>
            <div><h2>编辑标题</h2><p>修改后在历史列表中更易识别。</p></div>
            <input className="input" value={titleDraft} onChange={e=>setTitleDraft(e.target.value)} autoFocus placeholder="新标题"/>
            <div className="alert-actions"><button className="alert-btn" onClick={closeDialog}>取消</button><button className="alert-btn" onClick={submitRename} disabled={!titleDraft.trim()}>保存</button></div>
          </>:<>
            <div><h2>确认删除</h2><p>「{dialog.task.title}」及其运行记录将被移除。</p></div>
            <div className="alert-actions"><button className="alert-btn" onClick={closeDialog}>取消</button><button className="alert-btn alert-btn-destructive" onClick={submitDelete}>删除</button></div>
          </>}
        </m.div>
      </m.div>}</AnimatePresence>
    </div>
  )
}
function fmtS(s?:string){if(s==='running')return'执行中';if(s==='waiting_approval')return'待审批';if(s==='completed')return'已完成';if(s==='failed')return'失败';if(s==='cancelled')return'已取消';return'就绪'}
function fmtTS(s:string){if(s==='running')return'进行中';if(s==='completed')return'已完成';if(s==='blocked')return'待处理';if(s==='failed')return'失败';return'待命'}
function fmtKind(k:string){if(k==='approval')return'审批';if(k==='error')return'异常';return'消息'}
function fmtTime(v:string){const d=new Date(v);return isNaN(d.getTime())?'--:--:--':d.toLocaleTimeString('zh-CN')}
function fmtElapsed(v:string){const s=Math.max(0,Math.floor((Date.now()-new Date(v).getTime())/1000));return s<60?`${s}秒`:`${Math.floor(s/60)}分${s%60}秒`}
