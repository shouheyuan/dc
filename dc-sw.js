/**
 * DeepClick Service Worker 伪代码
 *
 * 这个文件用于理解 loader.js 和 dc-sw.js 的区别。
 *
 * 一句话区分：
 *
 * - loader.js 运行在页面里。
 *   它能访问 DOM、按钮、URL、history、localStorage。
 *   所以它负责：初始化 SDK、读取 click_id、保存上下文、绑定按钮、注册 Service Worker。
 *
 * - dc-sw.js 运行在浏览器的 Service Worker 线程里。
 *   它不能访问 DOM，也不能直接访问 window / document / localStorage。
 *   但它能在同源 scope 内处理 fetch、cache、push、notificationclick。
 *
 * 所以真实链路通常是：
 *
 *   页面加载
 *     ↓
 *   loader.js 执行
 *     ↓
 *   loader.js 注册 dc-sw.js
 *     ↓
 *   dc-sw.js 安装并激活
 *     ↓
 *   后续同源请求 / Push / 通知点击由 dc-sw.js 处理
 *
 * 注意：
 * 这个文件是教学伪代码，不做真实代理、不改写页面内容、不做 cloaking。
 *
 * 本文件重点回答这些问题：
 *
 * 1. install / activate 生命周期干嘛？
 *    install 是浏览器第一次安装或更新 SW 文件时触发。
 *    activate 是新 SW 真正接管页面前触发。
 *    SW 文件变更后浏览器会走更新流程，所以需要处理旧缓存、旧版本接管问题。
 *
 * 2. fetch 是不是拦截所有请求？
 *    不是全网请求。只会处理当前 Service Worker scope 内的请求。
 *    一般也不会全部改写，大多数请求直接透传，只有特定路径才处理。
 *
 * 3. cache 有什么用？
 *    用于缓存回流页壳、图标、离线页等资源。
 *    网络差或接口失败时，可以有兜底页面，不至于空白。
 *
 * 4. Web Push 能不能随便推？
 *    不能。需要 HTTPS、注册 SW、用户授权通知、浏览器生成 Push Subscription、
 *    服务端通过标准 Web Push 协议发送消息，SW 才会收到 push 事件。
 *
 * 5. 为什么接收 loader.js 的 message？
 *    因为 SW 不能读 DOM / window / localStorage。
 *    loader.js 要主动把 click_id / productId 传给 SW，SW 才能在 Push 点击或离线埋点里带上归因上下文。
 *
 * 6. 后台兜底逻辑是什么？
 *    页面发埋点失败时，SW 可以临时入队；Push 打开回流页时，SW 可以补 click_id；
 *    回流页资源失败时，SW 可以给缓存壳。
 */

const DC_SW_VERSION = "pseudo-v1";
const DC_CACHE_NAME = "deepclick-pseudo-cache-" + DC_SW_VERSION;

// SW 里不能用 localStorage。
// 这里用内存变量演示“接收 loader.js 发来的上下文后暂存起来”。
// 真实项目如果要长期保存，应该用 IndexedDB。
let lastClickContext = null;
const offlineEventQueue = [];

/**
 * install：Service Worker 第一次安装时触发。
 *
 * 真实 SDK 可能会在这里预缓存一些轻量资源，例如：
 * - 回流页壳资源
 * - 图标
 * - 离线兜底页
 *
 * 这里为了避免影响 demo，不主动缓存任何真实页面。
 *
 * 是否还要更新？
 * 要。只要 /dc-sw.js 文件内容发生变化，浏览器会发现新版本。
 * 新版本会先 install，再等待旧版本退出，最后 activate。
 * self.skipWaiting() 是告诉浏览器“新版本准备好后尽快进入激活阶段”。
 */
self.addEventListener("install", function onInstall(event) {
    console.log("[DeepClick sw pseudo] install:", DC_SW_VERSION);

    event.waitUntil(
        caches.open(DC_CACHE_NAME).then(function onCacheOpen(cache) {
            // 教学占位：
            // 真实代码可能写：
            // return cache.addAll(["/reflow-shell.html", "/dc-icon.png"]);
            return cache;
        })
    );

    // 让新的 SW 安装后尽快进入 activate 阶段。
    self.skipWaiting();
});

/**
 * activate：Service Worker 激活时触发。
 *
 * 真实 SDK 常在这里做：
 * - 清理旧版本缓存
 * - 接管当前已打开页面
 * - 上报 SW 激活状态
 *
 * 为什么要清理旧缓存？
 * 因为 SW 更新后，旧版本可能留下 deepclick-pseudo-cache-pseudo-v0 这类缓存。
 * 如果不清理，浏览器缓存会越积越多，也可能拿到旧回流页资源。
 */
self.addEventListener("activate", function onActivate(event) {
    console.log("[DeepClick sw pseudo] activate:", DC_SW_VERSION);

    event.waitUntil(
        caches.keys().then(function cleanOldCaches(cacheNames) {
            return Promise.all(
                cacheNames
                    .filter(function isOldDeepClickCache(cacheName) {
                        return cacheName.indexOf("deepclick-pseudo-cache-") === 0
                            && cacheName !== DC_CACHE_NAME;
                    })
                    .map(function deleteCache(cacheName) {
                        return caches.delete(cacheName);
                    })
            );
        }).then(function claimClients() {
            // clients.claim() 的意思是：
            // 不等用户刷新页面，尽量让当前打开的页面也被这个 SW 控制。
            return self.clients.claim();
        })
    );
});

/**
 * fetch：页面发起同源网络请求时触发。
 *
 * 这是 dc-sw.js 和 loader.js 最大的区别之一：
 *
 * - loader.js 只能在页面 JS 层做事，比如监听按钮点击。
 * - dc-sw.js 可以站在网络请求前面，观察或处理同源请求。
 *
 * 但浏览器限制很严格：
 * - 只能处理当前 Service Worker scope 里的请求。
 * - 不能随便接管别的域名。
 * - 如果 dc-sw.js 在 https://ads.abc.com/ 下，它管不了 https://abc.com/。
 *
 * 浏览器会把 scope 内的同源请求都交给这个 fetch 监听器。
 * 但“监听到”不等于“必须改写”。
 *
 * 常见做法是：
 * - 普通页面资源：直接透传 fetch(event.request)
 * - 回流页资源：可以缓存兜底
 * - 埋点接口：网络失败时可以先存离线队列
 *
 * 当前伪代码只演示两个分支：
 * - /dc/health：SW 自己生成响应，证明它能接管请求
 * - /dc/events：埋点请求失败时放进离线队列
 *
 * fetch 和归因的关系：
 * SW 不是归因本身。
 * 它能做的是增强链路可靠性，例如：
 * - 看到 /dc/events 这类埋点请求
 * - 网络失败时先入队
 * - 请求里缺少 click_id 时，在同源可控请求上补充上下文
 *
 * 是否拦截所有请求？
 * 浏览器会把 scope 内的请求都“通知”给这个监听器，
 * 但代码可以选择直接 return 或 event.respondWith(fetch(event.request)) 透传。
 * 真正应该处理的只是一小部分路径。
 */
self.addEventListener("fetch", function onFetch(event) {
    const requestUrl = new URL(event.request.url);

    // 只演示同源请求。
    // 非同源请求直接放行，不做处理。
    if (requestUrl.origin !== self.location.origin) {
        return;
    }

    // 示例：如果访问 /dc/health，SW 自己返回一个测试响应。
    // 这个分支只是为了说明“SW 可以自己生成响应”。
    if (requestUrl.pathname === "/dc/health") {
        event.respondWith(
            new Response(
                JSON.stringify({
                    ok: true,
                    from: "dc-sw.js",
                    version: DC_SW_VERSION
                }),
                {
                    headers: {
                        "content-type": "application/json"
                    }
                }
            )
        );
        return;
    }

    // 示例：埋点接口网络失败时，先放到离线队列。
    //
    // 这不是“做归因”的核心。
    // 归因核心是 click_id / fbclid / gclid 这些参数能不能一路传下去。
    //
    // SW 在这里的作用是兜底：
    // 如果用户刚好断网，页面发 /dc/events 失败，
    // SW 可以先记下来，等后面网络恢复再补发。
    if (requestUrl.pathname === "/dc/events" && event.request.method === "POST") {
        event.respondWith(
            fetch(event.request.clone()).catch(function onEventSendFailed() {
                offlineEventQueue.push({
                    url: event.request.url,
                    method: event.request.method,
                    clickId: lastClickContext && lastClickContext.clickId,
                    queuedAt: new Date().toISOString()
                });

                return new Response(
                    JSON.stringify({
                        ok: true,
                        queued: true,
                        reason: "network_failed",
                        queueSize: offlineEventQueue.length
                    }),
                    {
                        headers: {
                            "content-type": "application/json"
                        }
                    }
                );
            })
        );
        return;
    }

    // 默认：不接管、不改写，继续请求原始资源。
    //
    // 真实 SDK 可能会在这里做：
    // - 给特定请求补充追踪参数
    // - 对回流页资源做缓存兜底
    // - 对埋点请求做离线队列
    //
    // 这里不做这些，避免把教学伪代码变成真实代理逻辑。
    event.respondWith(fetch(event.request));
});

/**
 * message：接收页面发来的消息。
 *
 * 因为 dc-sw.js 不能直接读页面 DOM / localStorage，
 * 所以如果它需要 click_id、productId、用户状态等信息，
 * 通常要由 loader.js 通过 postMessage 主动发给它。
 *
 * 页面侧大概会这样：
 *
 * navigator.serviceWorker.controller.postMessage({
 *     type: "DEEPLINK_CLICK_CONTEXT",
 *     payload: { clickId: "xxx", productId: "abc_product_001" }
 * });
 *
 * loader.js 什么时候发？
 * 通常在：
 * - SW 注册完成后
 * - 页面读取并保存 click context 后
 * - 用户订阅 Push 成功后
 *
 * 发的目的不是让 SW 操作页面，而是让 SW 的后台能力也知道当前 click_id。
 */
self.addEventListener("message", function onMessage(event) {
    const message = event.data || {};

    if (message.type === "DEEPLINK_CLICK_CONTEXT") {
        console.log("[DeepClick sw pseudo] receive click context:", message.payload);

        // 暂存起来，后面 Push 点击、离线队列、缓存兜底都可能要用 click_id。
        lastClickContext = message.payload;

        // 真实代码可能会把上下文放到 IndexedDB。
        // Service Worker 不能用 localStorage。
        // 这里为了教学只存在内存里。
    }
});

/**
 * push：接收服务端 Web Push 消息。
 *
 * 这是 Service Worker 独有能力之一。
 * 页面关闭后，只要用户授权过通知，浏览器仍可能唤醒 SW 处理 Push。
 *
 * loader.js 本身做不到这个，因为 loader.js 只在页面打开时运行。
 *
 * Web Push 标准链路大概是：
 * 1. 页面请求通知权限：Notification.requestPermission()
 * 2. 页面通过 SW 注册拿到 Push Subscription：
 *    registration.pushManager.subscribe(...)
 * 3. loader.js 把 subscription 发给服务端保存。
 * 4. 服务端用 Web Push 协议和 VAPID 签名发送消息。
 * 5. 浏览器收到后唤醒 SW，触发这里的 push 事件。
 *
 * 所以它不能随便推：
 * - 用户必须授权通知
 * - 浏览器必须支持 Push
 * - 服务端必须持有 subscription
 * - 站点通常必须是 HTTPS
 */
self.addEventListener("push", function onPush(event) {
    let payload = {
        title: "DeepClick",
        body: "You have a new return offer.",
        url: "/reflow"
    };

    if (event.data) {
        try {
            payload = Object.assign(payload, event.data.json());
        } catch (error) {
            payload.body = event.data.text();
        }
    }

    event.waitUntil(
        self.registration.showNotification(payload.title, {
            body: payload.body,
            data: {
                url: payload.url
            }
        })
    );
});

/**
 * notificationclick：用户点击通知时触发。
 *
 * 真实 SDK 会在这里：
 * - 上报通知点击
 * - 打开回流页
 * - 带上 click_id / campaign 等参数
 *
 * 这个事件常用于“离站后再营销回流”：
 * 用户离开页面后收到通知，点击通知打开 /reflow。
 * 如果 SW 有 click_id，就把 click_id 追加到 URL 上，
 * 后续页面和后端还能知道这次回流来自哪个广告点击。
 */
self.addEventListener("notificationclick", function onNotificationClick(event) {
    event.notification.close();

    const baseUrl = event.notification.data && event.notification.data.url
        ? event.notification.data.url
        : "/reflow";

    // 如果 SW 之前从 loader.js 收到过 click context，
    // 通知点击打开回流页时，就可以把 click_id 带回去。
    const targetUrl = new URL(baseUrl, self.location.origin);
    if (lastClickContext && lastClickContext.clickId) {
        targetUrl.searchParams.set("click_id", lastClickContext.clickId);
        targetUrl.searchParams.set("from", "web_push");
    }

    event.waitUntil(
        self.clients.openWindow(targetUrl.pathname + targetUrl.search)
    );
});
