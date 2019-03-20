import * as http from 'http'
import * as https from 'https'
import * as net from 'net'
import * as tls from 'tls'
import * as url from 'url'
import { getProxyForUrl } from 'proxy-from-env'

function createProxySock (proxy) {
  if (proxy.protocol === 'http:') {
    return net.connect(proxy.port || 80, proxy.hostname)
  }

  if (proxy.protocol === 'https:') {
    // if the upstream is https, we need to wrap the socket with tls
    return tls.connect(proxy.port || 443, proxy.hostname)
  }

  // socksv5, etc...
  throw new Error(`Unsupported proxy protocol: ${proxy.protocol}`)
}

class HttpAgent extends http.Agent {
  httpsAgent: https.Agent

  constructor (opts: http.AgentOptions = {}) {
    opts.keepAlive = true
    super(opts)
    // we will need this if they wish to make http requests over an https proxy
    this.httpsAgent = new https.Agent({ keepAlive: true })
  }

  createSocket (req, options, cb) {
    if (process.env.HTTP_PROXY) {
      const proxy = getProxyForUrl(options.href)

      if (proxy) {
        options.proxy = proxy

        return this._createProxiedSocket(req, options, cb)
      }
    }

    // @ts-ignore
    super.createSocket(req, options, cb)
  }

  _createProxiedSocket (req, options, cb) {
    const proxy = url.parse(options.proxy)

    // set req.path to the full path so the proxy can resolve it
    req.path = options.href
    req.setHeader('host', `${options.host}:${options.port}`)
    if (proxy.auth) {
      req.setHeader('proxy-authorization', `basic ${Buffer.from(proxy.auth).toString('base64')}`)
    }

    options.port = proxy.port
    options.host = proxy.hostname
    delete options.path // so the underlying net.connect doesn't default to IPC

    if (proxy.protocol === 'https:') {
      // gonna have to use the https module instead
      req.agent = this.httpsAgent

      // @ts-ignore
      return this.httpsAgent.addRequest(req, options)
    }

    // @ts-ignore
    super.createSocket(req, options, cb)
  }
}

class HttpsAgent extends https.Agent {
  constructor (opts: https.AgentOptions = {}) {
    opts.keepAlive = true
    super(opts)
  }

  createConnection (options, cb) {
    if (process.env.HTTPS_PROXY) {
      const proxy = getProxyForUrl(options.href)

      if (proxy) {
        options.proxy = proxy

        return this._createProxiedConnection(options, cb)
      }
    }

    // @ts-ignore
    cb(null, super.createConnection(options))
  }

  // https://github.com/mknj/node-keepalive-proxy-agent/blob/master/index.js
  _createProxiedConnection (options, cb) {
    const proxy = url.parse(options.proxy)

    const proxySocket = createProxySock(proxy)

    const onError = (err) => {
      proxySocket.destroy()
      cb(err)
    }

    proxySocket.once('error', onError)
    proxySocket.once('data', (data) => {
      proxySocket.removeListener('error', onError)
      // read status code from proxy's response
      const matches = data.toString().match(/^HTTP\/1.1 (\d*)/)

      if (matches[1] !== '200') {
        proxySocket.destroy()

        return cb(new Error(`Error establishing proxy connection: ${matches[0]}`))
      }

      // https.Agent will reuse this socket now that we've set it
      options.socket = proxySocket

      // @ts-ignore
      cb(null, super.createConnection(options))
    })

    let connectReq = `CONNECT ${options.uri.hostname}:${options.uri.port} HTTP/1.1\r\n`

    connectReq += `Host: ${options.uri.hostname}:${options.uri.port}\r\n`

    if (proxy.auth) {
      connectReq += `Proxy-Authorization: basic ${Buffer.from(proxy.auth).toString('base64')}\r\n`
    }

    connectReq += '\r\n'
    proxySocket.write(connectReq)
  }
}

module.exports = {
  http: new HttpAgent(),
  https: new HttpsAgent(),
}