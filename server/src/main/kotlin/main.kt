package ch.nokillswit

import ch.nokillswit.plugins.rearmReadTimeout
import io.ktor.server.engine.EmbeddedServer
import io.ktor.server.netty.EngineMain
import io.ktor.server.netty.NettyApplicationEngine

/** `EngineMain.main` is exactly `createServer(args).start(wait = true)`; the only addition is the repeating read timeout. */
fun main(args: Array<String>) {
    createServer(args).start(wait = true)
}

/** `EngineMain.createServer` plus the per-request read timeout (`plugins/ReadTimeout.kt`); `RequestReadTimeoutTest` boots through it. */
internal fun createServer(args: Array<String>): EmbeddedServer<NettyApplicationEngine, NettyApplicationEngine.Configuration> =
    EngineMain.createServer(args).also { it.engine.configuration.rearmReadTimeout() }
