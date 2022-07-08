import { WS } from "fastify-modular-route"
import WebSocket from "isomorphic-ws"
import { pito } from "pito"
import QueryString from "qs"
import { v4 } from "uuid"
import { GenericState } from "./generic-state.js"
import { RequestArgs, Requester, WSArgs } from "./index.js"
import { jwtBearer } from "./known-presets.js"

export type WSManager<Send, Recv, Request extends Record<string, { args: [pito] | [...pito[]], return: pito }>, Response extends Record<string, { args: [pito] | [...pito[]], return: pito }>, Fail> = {
    socket: any,
    send(data: Send): void,
    request<Rq extends keyof Request>(key: Rq, ...args: pito.MapType<Request[Rq]['args']>): Promise<pito.Type<Request[Rq]['return']>>
    onReceive(handler: (data: Recv) => void | Promise<void>): void,
    onResponse<Rs extends keyof Response>(key: Rs, handler: (...args: pito.MapType<Response[Rs]['args']>) => Promise<pito.Type<Response[Rs]['return']>>): void,
    close(): void,
    until(): Promise<void>,
}


function blobOrBuffer(target: any): string {
    if (target.text !== undefined) {
        return target.text()
    } else {
        return target.toString()
    }
}
export async function requestWS<
    WsAPI extends WS<string, string, any, any, any, any, any, any, any>
>(
    req: Requester,
    api: WsAPI,
    args: RequestArgs<GenericState, WsAPI>,
): Promise<WSManager<any, any, any, any, any>> {
    // setup host
    const host = req.host.resolve(api)
    // setup path
    const path = req.path.resolve(api.path, api.params, (args.params ?? {}) as any)
    // setup headers
    const headers: Record<string, string | number | boolean> = {}
    jwtBearer(api, args, (token) => { headers['authorization'] = `bearer ${token}` })
    // setup url
    const url = new URL(`${host}${path}`)
    url.search = QueryString.stringify(args.query)
    switch (url.protocol) {
        case "http:":
            url.protocol = "ws:"
            break
        case "https:":
            url.protocol = "wss:"
            break
        default:
            throw new Error(`unexpected url protocol ${url.protocol}`)
    }
    // setup websocket
    const ws = new WebSocket(url.toString())
    const on = {
        receive: (data: any): void | Promise<void> => { },
        req: {} as Record<string, { resolve: (result: any) => void, reject: (error: any) => void }>,
        res: {} as Record<string, (...args: any[]) => Promise<any>>,
        close: [] as (() => void)[]
    }
    return new Promise<WSManager<any, any, any, any, any>>((resolve, reject) => {
        // 중간에 끊기면 자동으로 promise 취소
        ws.onclose = (ev) => {
            reject(ev)
        }
        // 연결 대기중
        ws.onmessage = (data) => {
            const packet = JSON.parse(blobOrBuffer(data.data))
            switch (packet.type) {
                case "need-header":
                    // 헤더 셋업
                    ws.send(JSON.stringify({ type: 'header', header: headers }))
                    return
                case "complete":
                    // 헤더 셋업
                    ws.send(JSON.stringify({ type: 'ready' }))
                    // 모든 작업이 완료됨
                    ws.onmessage = (payload) => {
                        const data = JSON.parse(blobOrBuffer(payload.data))
                        switch (data.type) {
                            case "send":

                                const thenIfPromise = on.receive(pito.unwrap(api.send, data.payload))
                                if (thenIfPromise instanceof Promise) {
                                    thenIfPromise.then()
                                }
                                break
                            case "req":
                                if (!(data.method in on.res)) {
                                    throw new Error(`'${data.method}'를 서버에서 요청했지만 처리할 수 없습니다.`)
                                }
                                on.res[data.method](...data.args.map((v: any, i: number) => {
                                    return pito.unwrap(api.request[data.method].args[i], v)
                                })).then(result => {
                                    ws.send(JSON.stringify({
                                        type: 'res',
                                        id: data.id,
                                        method: data.mehtod,
                                        result
                                    }))
                                })
                                break
                            case "res":
                                if (!(data.id in on.req)) {
                                    throw new Error(`'${data.id}'를 서버에서 받았지만 알수 없는 응답입니다.`)
                                }
                                on.req[data.id].resolve(
                                    pito.unwrap(api.response[data.method].return, data.result)
                                )
                                delete on.req[data.id]
                                break
                        }
                    }
                    ws.onclose = () => {
                        for (const closeHandler of on.close) {
                            closeHandler()
                        }
                    }
                    resolve({
                        socket: ws,
                        send: (payload) => {
                            return ws.send(JSON.stringify({ type: 'send', payload: pito.wrap(api.recv, payload) }))
                        },
                        // 요청 보내기
                        request: (key, ...args) => {
                            // uuid기반으로 새 요청 생성
                            const id = v4()
                            return new Promise((resolve, reject) => {
                                //req에 id 기반으로 promise를 저장해 두었다가 처리.
                                on.req[id] = { resolve, reject }
                                ws.send(JSON.stringify({
                                    type: 'req',
                                    id,
                                    method: key as string,
                                    args: args.map((v, i) => {
                                        return pito.wrap(api.response[key].args[i], v)
                                    }),
                                }))
                            })
                        },
                        onReceive: (handler) => { on.receive = handler },
                        onResponse: (key, handler) => {
                            on.res[key as string] = handler
                        },
                        close: () => { ws.close() },
                        until: () => {
                            return new Promise(resolve => {
                                if (ws.readyState === ws.CLOSED) {
                                    resolve()
                                } else {
                                    on.close.push(resolve)
                                }
                            })
                        },
                    })
                    return
            }
        }
    })
}
