package ch.nokillswit.plugins

import io.ktor.server.netty.NettyApplicationEngine
import io.netty.channel.ChannelHandlerContext
import io.netty.channel.ChannelInboundHandlerAdapter
import io.netty.handler.timeout.ReadTimeoutException
import io.netty.handler.timeout.ReadTimeoutHandler

/** The name Ktor's `NettyChannelInitializer` gives its HTTP/1.1 read-timeout handler (added only when the timeout is above 0). */
private const val KTOR_READ_TIMEOUT_HANDLER = "readTimeout"

/**
 * Ktor's `KtorReadTimeoutHandler` is Netty's `ReadTimeoutHandler` with a one-shot flag: after its first firing it never reports again,
 * so a connection that idled past the timeout once (the firing reaches the pipeline tail with no call open) is never cut for a
 * later stalled request. Netty's `IdleStateHandler` underneath re-schedules itself every interval, so this one simply reports on
 * EVERY firing and, like Ktor's, closes nothing itself: `NettyHttp1Handler.exceptionCaught` answers 408 and closes when a call is open.
 */
internal class RepeatingReadTimeoutHandler(timeoutSeconds: Int) : ReadTimeoutHandler(timeoutSeconds) {
    override fun readTimedOut(ctx: ChannelHandlerContext) {
        ctx.fireExceptionCaught(ReadTimeoutException.INSTANCE)
    }
}

/**
 * Last in the pipeline: a read timeout with no call open reaches here (an idle keep-alive connection is deliberately kept) and
 * is dropped, which also silences Netty's "exceptionCaught() reached at the tail of the pipeline" WARN. Anything else goes on.
 */
internal class ReadTimeoutTail : ChannelInboundHandlerAdapter() {
    override fun exceptionCaught(ctx: ChannelHandlerContext, cause: Throwable) {
        if (cause !is ReadTimeoutException) ctx.fireExceptionCaught(cause)
    }
}

/**
 * Swaps Ktor's one-shot read-timeout handler for [RepeatingReadTimeoutHandler] (same name, same slot, same
 * `requestReadTimeoutSeconds`) and appends [ReadTimeoutTail], on every HTTP/1.1 pipeline. `channelPipelineConfig` is read when the
 * engine starts and runs after Ktor has built the pipeline; a pipeline without the handler (timeout 0 = off, HTTP/2) is left alone.
 * Called from `main.kt` after `EngineMain.createServer`, before `start`.
 */
internal fun NettyApplicationEngine.Configuration.rearmReadTimeout() {
    val timeoutSeconds = requestReadTimeoutSeconds
    val previous = channelPipelineConfig
    channelPipelineConfig = { pipeline ->
        previous(pipeline)
        if (pipeline.get(KTOR_READ_TIMEOUT_HANDLER) != null) {
            pipeline.replace(KTOR_READ_TIMEOUT_HANDLER, KTOR_READ_TIMEOUT_HANDLER, RepeatingReadTimeoutHandler(timeoutSeconds))
            pipeline.addLast(ReadTimeoutTail())
        }
    }
}
