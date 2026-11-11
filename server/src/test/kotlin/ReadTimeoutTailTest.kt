package ch.nokillswit

import ch.nokillswit.plugins.ReadTimeoutTail
import io.netty.channel.ChannelHandlerContext
import io.netty.channel.ChannelInboundHandlerAdapter
import io.netty.channel.embedded.EmbeddedChannel
import io.netty.handler.timeout.ReadTimeoutException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** `ReadTimeoutTail` (`plugins/ReadTimeout.kt`): drops a read timeout, forwards every other exception to the next handler. */
class ReadTimeoutTailTest {

    /** Stands in for Netty's own tail: records what reaches it. */
    private class Recorder : ChannelInboundHandlerAdapter() {
        val seen = mutableListOf<Throwable>()

        override fun exceptionCaught(ctx: ChannelHandlerContext, cause: Throwable) {
            seen += cause
        }
    }

    @Test
    fun `a read timeout is dropped and any other exception reaches the next handler`() {
        val recorder = Recorder()
        val channel = EmbeddedChannel(ReadTimeoutTail(), recorder)
        channel.pipeline().fireExceptionCaught(ReadTimeoutException.INSTANCE)
        assertTrue(recorder.seen.isEmpty(), "a ReadTimeoutException must not pass the tail handler: ${recorder.seen}")
        val other = IllegalStateException("boom")
        channel.pipeline().fireExceptionCaught(other)
        assertEquals(listOf<Throwable>(other), recorder.seen)
        channel.finishAndReleaseAll()
    }
}
