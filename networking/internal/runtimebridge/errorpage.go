package runtimebridge

import (
	"net/http"
	"strings"
)

// streamFailedPage is the readable page a browser gets when the gateway could
// not carry a request to the remote workbench (the proxy ErrorHandler's 502).
//
// The failure code stays on the page so a user can report it, but the words
// lead with what actually fixes the two common causes: a firewall dropping UDP
// between the machines, or the machines not being reachable from each other at
// all. A bare code taught nobody what to do; this page exists so the first
// thing a user sees is the check to run.
func streamFailedPage(request *http.Request) string {
	accepted := request.Header.Get("Accept-Language")
	zh := strings.HasPrefix(strings.ToLower(strings.TrimSpace(strings.Split(accepted, ",")[0])), "zh")
	if zh {
		return streamFailedPageZH
	}
	return streamFailedPageEN
}

const streamFailedPageZH = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>无法打开远程工作台</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; margin: 0; padding: 48px 20px; background: #f7f7f8; color: #1f2328; }
  main { max-width: 620px; margin: 0 auto; background: #fff; border: 1px solid #e3e3e6; border-radius: 12px; padding: 32px 36px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p { font-size: 14px; line-height: 1.7; margin: 8px 0; }
  ol { font-size: 14px; line-height: 1.8; margin: 8px 0 16px; padding-left: 22px; }
  li { margin: 4px 0; }
  .code { font-size: 12px; color: #6e7781; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; margin-top: 16px; padding-top: 12px; border-top: 1px solid #eef0f2; }
  code { font-family: inherit; }
</style>
</head>
<body>
<main>
  <h1>无法打开远程工作台</h1>
  <p>连接已建立，但请求没能到达对方电脑的工作台。最常见的原因是<b>防火墙拦截了两台电脑之间的 UDP 流量</b>。</p>
  <p>请按顺序检查：</p>
  <ol>
    <li>对方电脑的防火墙是否放行了 UDP 流量。macOS：「系统设置 → 网络 → 防火墙」；Windows：「Windows 安全中心 → 防火墙和网络保护」，为本应用添加入站放行规则。</li>
    <li>两台电脑是否在同一个可互相访问的网络（同一 Wi-Fi、同一 VPN、同一局域网）。</li>
    <li>双方是否都已登录同一账号且在线，配对是否仍然有效。</li>
    <li>如果经常连上后很快断开，通常是连接保活包被丢弃，需要配置服务器的 TURN 中继。</li>
  </ol>
  <p>完成检查后，在远程连接页重新连接即可。</p>
  <p class="code">错误码：p2p.stream_failed</p>
</main>
</body>
</html>
`

const streamFailedPageEN = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Remote workbench unavailable</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 48px 20px; background: #f7f7f8; color: #1f2328; }
  main { max-width: 620px; margin: 0 auto; background: #fff; border: 1px solid #e3e3e6; border-radius: 12px; padding: 32px 36px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p { font-size: 14px; line-height: 1.7; margin: 8px 0; }
  ol { font-size: 14px; line-height: 1.8; margin: 8px 0 16px; padding-left: 22px; }
  li { margin: 4px 0; }
  .code { font-size: 12px; color: #6e7781; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; margin-top: 16px; padding-top: 12px; border-top: 1px solid #eef0f2; }
</style>
</head>
<body>
<main>
  <h1>Remote workbench unavailable</h1>
  <p>The connection is up, but requests could not reach the workbench on the other computer. The most common cause is a <b>firewall dropping UDP between the two computers</b>.</p>
  <p>Check, in order:</p>
  <ol>
    <li>That the other computer's firewall allows UDP. macOS: System Settings &rarr; Network &rarr; Firewall. Windows: Windows Security &rarr; Firewall &amp; network protection, and allow this app through.</li>
    <li>That both computers are on a mutually reachable network (same Wi-Fi, same VPN, same LAN).</li>
    <li>That both sides are signed in to the same account, online, and the pairing is still valid.</li>
    <li>If the connection frequently drops right after it comes up, keep-alive packets are being lost; configure the server's TURN relay.</li>
  </ol>
  <p>Reconnect from the Remote Connections page once the checks are done.</p>
  <p class="code">Error code: p2p.stream_failed</p>
</main>
</body>
</html>
`
