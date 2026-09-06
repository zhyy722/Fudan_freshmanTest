// ==UserScript==
// @name         复旦大学实验室安全考试 · 考前学习自动挂机阅读
// @namespace    https://lsem.fudan.edu.cn/
// @version      1.0.0
// @description  考前学习资料自动挂机：依次打开未学习课件，倒计时走完后自动点“阅读完成”，支持暂停/跳过/停止。打开页面即自动开始。
// @author       Codex
// @match        https://lsem.fudan.edu.cn/fd_aqks_new/examProgress/examOnline/examProgressOnlineIndex*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * 使用方法（二选一，本文件两个方式通用）：
 *
 * 方式 1：控制台（最快，适合现在用）
 *   在考试学习页按 F12 -> Console -> 全选复制本文件全部内容 -> 粘贴 -> 回车，即自动开始。
 *
 * 方式 2：油猴 Tampermonkey（适合长期重复使用）
 *   安装 Tampermonkey -> 点扩展图标 -> “添加新脚本” -> 全选删除默认内容 ->
 *   粘贴本文件全部内容 -> Ctrl+S 保存 -> 刷新学习页，即自动开始。
 *
 * 操作：
 *   ▶ 开始       开始/恢复挂机
 *   ⏸ 暂停/继续  暂停（弹窗若开着，倒计时仍会走）
 *   ⏭ 跳过当前   保存当前课件已读时长并跳到下一份
 *   ⏹ 停止       停止并保存当前进度
 *
 * 注意：
 *   1. 保持本标签页在前台（窗口不要最小化）。页面隐藏超过几分钟后，浏览器会降低网页
 *      计时器速度，倒计时会变慢。
 *   2. 全部读完脚本自动停止，不会替你点页面上的“学习完成”去开始考试。
 *   3. 登录会话过期时提交会失败，脚本会保留进度并跳过，重新登录后点“开始”即可续读。
 */

(function () {
  'use strict';

  var AUTO_START = true; // true：页面加载后自动开始；想手动开始改成 false
  var PANEL_ID = 'fudanAutoReadPanel';

  var running = false;
  var stoppedByUser = false;
  var paused = false;
  var doneCount = 0;
  var skipped = new Set();
  var completedThisRun = new Set();
  var currentDocId = null;
  var docNames = {};
  var lastKeepAlive = 0;
  var lastStatusText = '';

  // 防止重复注入（比如油猴和手动粘贴同时存在）
  if (document.getElementById(PANEL_ID)) return;

  /* ---------- 小工具 ---------- */
  function q1(sel, root) { return (root || document).querySelector(sel); }
  function qA(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtMs(ms) {
    ms = Math.max(0, Math.floor((ms || 0) / 1000));
    return pad2(Math.floor(ms / 60)) + ':' + pad2(ms % 60);
  }
  function log(msg) {
    if (window.console && console.log) console.log('[自动挂机阅读] ' + msg);
  }
  function setStatus(msg) {
    var el = document.getElementById(PANEL_ID + '_status');
    if (el) el.textContent = msg;
    if (msg !== lastStatusText) { lastStatusText = msg; log(msg); }
  }

  /* ---------- 学习弹窗 ---------- */
  function studyModals() {
    return qA('.modal.in').filter(function (m) {
      return m.querySelector && m.querySelector('input#id');
    });
  }
  function topStudyModal() {
    var list = studyModals();
    return list.length ? list[list.length - 1] : null;
  }
  function modalById(id) {
    var list = studyModals().filter(function (m) {
      return m.querySelector('input#id').value === String(id);
    });
    return list.length ? list[list.length - 1] : null;
  }
  function footerBtn(modal, label) {
    var footer = modal.querySelector('.modal-footer');
    if (!footer) return null;
    return qA('button', footer).filter(function (b) {
      return (b.textContent || '').indexOf(label) >= 0;
    })[0] || null;
  }

  /* ---------- 表格解析 / 翻页 ---------- */
  function parseRow(tr) {
    var txt = tr.textContent || '';
    if (txt.indexOf('未学习') < 0) return null;
    var a = null;
    qA('a', tr).forEach(function (x) {
      var oc = x.getAttribute('onclick') || '';
      if (!a && (oc.indexOf('showPdf(') >= 0 || oc.indexOf('showVideo(') >= 0)) a = x;
    });
    if (!a) return null;
    var m = (a.getAttribute('onclick') || '').match(/show(?:Pdf|Video)\('(\d+)'\)/);
    if (!m) return null;
    var lab = tr.querySelector('lable'); // 页面模板里就是这个标签名
    var name = (lab ? lab.textContent : txt) || txt;
    name = name.replace(/[（(](?:已|未)学习[)）]/g, '').trim();
    docNames[m[1]] = name;
    return { id: m[1], name: name, link: a };
  }
  function scanUnlearned() {
    var rows = qA('#studentStudyTable tbody tr');
    var out = [];
    rows.forEach(function (tr) {
      var r = parseRow(tr);
      if (r) out.push(r);
    });
    return out;
  }
  function nextPageBtn() { return document.getElementById('studentStudyTable_next'); }
  function hasNextPage() {
    var b = nextPageBtn();
    return !!b && (b.className || '').indexOf('disabled') < 0;
  }
  function clickNextPage() {
    var b = nextPageBtn();
    if (!b) return;
    var a = b.querySelector('a');
    try { (a || b).click(); } catch (e) {}
  }
  function isProcessing() {
    var p = q1('#studentStudyTable_processing');
    if (!p) return false;
    var cs = window.getComputedStyle ? window.getComputedStyle(p) : null;
    return !(cs && cs.display === 'none');
  }
  async function waitTableStable(timeoutMs) {
    var t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (!isProcessing() && qA('#studentStudyTable tbody tr').length > 0) return true;
      await sleep(400);
    }
    return false;
  }

  /* ---------- 会话保活 ---------- */
  function keepAlive() {
    try {
      var url = location.pathname + location.search;
      fetch(url, { method: 'GET', credentials: 'include', cache: 'no-store' }).catch(function () {});
      log('发送心跳请求，保持登录会话');
    } catch (e) {}
  }

  /* ---------- 单个课件的流程 ---------- */
  async function waitModal(id, timeoutMs) {
    var t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      var m = modalById(id);
      if (m && m.querySelector('#readTime') && footerBtn(m, '阅读完成')) return m;
      await sleep(400);
    }
    return null;
  }

  // 等待倒计时结束。返回：ready / status1 / paused / stopped / closed / timeout
  async function waitUntilReady(modal, name) {
    var t0 = Date.now();
    while (document.body.contains(modal)) {
      if (stoppedByUser) return 'stopped';
      if (paused) return 'paused';
      var st = modal.querySelector('#status');
      var re = modal.querySelector('#readEnd');
      var rt = modal.querySelector('#readTime');
      if (!st || !re || !rt) { await sleep(400); continue; } // 弹窗内容尚未加载完
      if (st.value === '1') return 'status1';
      if (re.value === '1') return 'ready';
      var remain = parseInt(rt.value, 10);
      if (!isNaN(remain)) {
        setStatus('正在阅读：' + name + '　剩余 ' + fmtMs(remain));
        if (Date.now() - lastKeepAlive > 120000 && remain > 60000) {
          keepAlive();
          lastKeepAlive = Date.now();
        }
      }
      if (Date.now() - t0 > 2 * 60 * 60 * 1000) return 'timeout';
      await sleep(1000);
    }
    return 'closed';
  }

  // 关掉其它系统提示弹窗（不是学习内容弹窗）
  function dismissAlerts() {
    qA('.modal.in').forEach(function (m) {
      if (m.querySelector('input#id')) return;
      var ok = m.querySelector('.modal-footer .btn');
      if (ok) { try { ok.click(); } catch (e) {} }
    });
  }

  // 点“阅读完成”，直到学习弹窗关闭
  async function clickComplete(modal) {
    var btn = footerBtn(modal, '阅读完成');
    if (!btn) return false;
    try { btn.click(); } catch (e) { return false; }
    var t0 = Date.now();
    while (document.body.contains(modal)) {
      dismissAlerts();
      if (Date.now() - t0 > 15000) return false;
      await sleep(400);
    }
    return true;
  }

  function saveAndClose(modal) {
    if (!modal || !document.body.contains(modal)) return;
    var btn = footerBtn(modal, '保留阅读时长');
    if (!btn) btn = footerBtn(modal, '阅读完成');
    if (btn) { try { btn.click(); } catch (e) {} }
  }

  async function processModal(modal) {
    var idEl = modal.querySelector('#id');
    if (!idEl) return 'error';
    var id = idEl.value;
    var name = docNames[id] || ('课件 ' + id);

    var reason = await waitUntilReady(modal, name);
    if (reason === 'stopped') {
      if (document.body.contains(modal)) saveAndClose(modal);
      setStatus('已停止，并保存了当前进度：' + name);
      return 'stopped';
    }
    if (reason === 'paused') {
      setStatus('已暂停：' + name + '（弹窗倒计时仍在走）');
      return 'paused';
    }
    if (reason === 'closed') {
      setStatus('学习弹窗被关闭（未提交）：' + name);
      return 'closed';
    }
    if (reason === 'timeout') {
      saveAndClose(modal);
      skipped.add(id);
      setStatus('等待超时，已保存进度并跳过：' + name);
      return 'error';
    }
    if (reason === 'status1') {
      // 服务器已判定完成，只需关闭弹窗
      if (await clickComplete(modal)) {
        completedThisRun.add(id);
        setStatus('已确认完成：' + name);
        return 'done';
      }
      saveAndClose(modal);
      return 'error';
    }

    // reason === 'ready'：倒计时结束，提交完成记录
    setStatus('时间到，正在提交完成记录：' + name);
    var ok = false;
    for (var i = 0; i < 3; i++) {
      if (!document.body.contains(modal)) { ok = true; break; }
      ok = await clickComplete(modal);
      if (ok) break;
    }
    if (ok) {
      doneCount++;
      completedThisRun.add(id);
      setStatus('已完成（本轮累计 ' + doneCount + ' 份）：' + name);
      return 'done';
    }
    saveAndClose(modal);
    skipped.add(id);
    setStatus('提交未能确认，已保存进度并跳过：' + name);
    return 'error';
  }

  /* ---------- 主循环 ---------- */
  async function run() {
    if (running) return;
    running = true;
    stoppedByUser = false;
    paused = false;
    doneCount = 0;
    skipped = new Set();
    completedThisRun = new Set();
    currentDocId = null;
    lastKeepAlive = 0;
    setStartBtn(true);
    setStatus('已开始自动挂机…');

    if (!(await waitTableStable(10000))) {
      setStatus('学习列表尚未加载完成，请刷新页面后再点“开始”。');
      running = false;
      setStartBtn(false);
      return;
    }

    while (true) {
      if (stoppedByUser) { setStatus('已停止。'); break; }
      if (paused) { await sleep(800); continue; }

      // 1) 处理已经打开的课件弹窗（例如刷新前/粘贴前打开的）
      var modal = topStudyModal();
      if (modal) {
        var idEl = modal.querySelector('#id');
        if (idEl) {
          var openId = idEl.value;
          if (completedThisRun.has(openId)) {
            saveAndClose(modal); // 残留的重复弹窗，直接关掉
            await sleep(800);
            continue;
          }
          currentDocId = openId;
          var name = docNames[openId] || ('课件 ' + openId);
          var res = await processModal(modal);
          currentDocId = null;
          if (res === 'done' || res === 'error' || res === 'closed') await sleep(1200); // 等表格刷新
          continue;
        }
      }

      // 2) 打开本页下一份未学习课件
      var rows = scanUnlearned();
      var next = null;
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (skipped.has(r.id) || r.id === currentDocId) continue;
        next = r;
        break;
      }
      if (next) {
        currentDocId = next.id;
        setStatus('正在打开：' + next.name);
        try { next.link.click(); } catch (e) {}
        var opened = await waitModal(next.id, 25000);
        currentDocId = null;
        if (!opened) {
          skipped.add(next.id);
          setStatus('打开失败，已跳过：' + next.name);
          continue;
        }
        continue;
      }

      // 3) 本页没有未学习的了，翻下一页
      if (hasNextPage()) {
        setStatus('本页已读完，正在翻到下一页…');
        clickNextPage();
        if (!(await waitTableStable(10000))) {
          setStatus('翻页超时，请检查网络后再点“开始”。');
          break;
        }
        await sleep(800);
        continue;
      }

      // 4) 全部完成
      var msg = '🎉 全部未学习资料已阅读完成（本轮完成 ' + doneCount + ' 份';
      if (skipped.size > 0) msg += '，另有 ' + skipped.size + ' 份已跳过';
      msg += '）。请人工确认列表状态；脚本不会替你点“学习完成”开始考试。';
      setStatus(msg);
      break;
    }

    running = false;
    setStartBtn(false);
  }

  /* ---------- 操作按钮 ---------- */
  function skipCurrent() {
    var modal = topStudyModal();
    if (!modal) {
      setStatus('当前没有打开的学习弹窗。');
      return;
    }
    var idEl = modal.querySelector('#id');
    var id = idEl ? idEl.value : null;
    if (id) skipped.add(id);
    currentDocId = null;
    var name = id ? (docNames[id] || ('课件 ' + id)) : '当前课件';
    saveAndClose(modal);
    setStatus('已保存进度并跳过：' + name);
  }

  function togglePause() {
    if (!running) { setStatus('请先点“开始”。'); return; }
    paused = !paused;
    setStatus(paused ? '已暂停（若弹窗开着，倒计时仍在走）。' : '已继续，正在处理…');
  }

  function stopAll() {
    stoppedByUser = true;
    paused = false;
    var modal = topStudyModal();
    if (modal && running) saveAndClose(modal);
    setStatus('已停止。');
  }

  /* ---------- 悬浮面板 ---------- */
  function setStartBtn(on) {
    var b = document.getElementById(PANEL_ID + '_start');
    if (!b) return;
    if (on) {
      b.textContent = '⏳ 运行中…';
      b.style.background = '#7a8699';
      b.disabled = true;
    } else {
      b.textContent = '▶ 开始';
      b.style.background = '#2f9e6e';
      b.disabled = false;
    }
  }

  function buildPanel() {
    var box = document.createElement('div');
    box.id = PANEL_ID;
    box.innerHTML =
      '<div style="position:fixed;right:16px;bottom:16px;z-index:2147483000;width:292px;padding:12px 14px;background:rgba(18,23,35,0.96);color:#e8eef7;font:13px/1.7 \'Microsoft YaHei\',\'PingFang SC\',sans-serif;border:1px solid #43536d;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,0.45)">' +
        '<div style="font-weight:bold;font-size:14px;margin-bottom:6px">📖 考前学习自动挂机阅读</div>' +
        '<div id="' + PANEL_ID + '_status" style="min-height:44px;max-height:100px;overflow:auto;background:rgba(0,0,0,0.3);border-radius:6px;padding:6px 8px;margin-bottom:8px;white-space:pre-wrap;word-break:break-all"></div>' +
        '<div>' +
          '<button id="' + PANEL_ID + '_start" style="margin:2px 3px;padding:4px 10px;cursor:pointer;border:0;border-radius:6px;background:#2f9e6e;color:#fff">▶ 开始</button>' +
          '<button id="' + PANEL_ID + '_pause" style="margin:2px 3px;padding:4px 10px;cursor:pointer;border:0;border-radius:6px;background:#d89a2b;color:#fff">⏸ 暂停</button>' +
          '<button id="' + PANEL_ID + '_skip" style="margin:2px 3px;padding:4px 10px;cursor:pointer;border:0;border-radius:6px;background:#4a6fa5;color:#fff">⏭ 跳过当前</button>' +
          '<button id="' + PANEL_ID + '_stop" style="margin:2px 3px;padding:4px 10px;cursor:pointer;border:0;border-radius:6px;background:#c0504d;color:#fff">⏹ 停止</button>' +
        '</div>' +
        '<div style="font-size:11px;color:#9db1c8;margin-top:6px">保持本标签页在前台（窗口不要最小化），倒计时才正常。全部读完自动停止，不会替你点“学习完成”开始考试。</div>' +
      '</div>';
    document.body.appendChild(box);

    document.getElementById(PANEL_ID + '_start').onclick = function () { run(); };
    document.getElementById(PANEL_ID + '_pause').onclick = togglePause;
    document.getElementById(PANEL_ID + '_skip').onclick = skipCurrent;
    document.getElementById(PANEL_ID + '_stop').onclick = stopAll;
  }

  /* ---------- 启动 ---------- */
  buildPanel();
  setStatus('准备就绪：点“▶ 开始”将自动阅读全部未学习资料。');
  if (AUTO_START) setTimeout(function () { run(); }, 800);
})();
