package ch.nokillswit

import io.r2dbc.spi.Connection
import io.r2dbc.spi.ConnectionFactories
import io.r2dbc.spi.ConnectionFactory
import io.r2dbc.spi.ConnectionFactoryOptions
import io.r2dbc.spi.Statement
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabaseConfig
import org.reactivestreams.Publisher
import reactor.core.publisher.Mono
import java.util.Collections

/**
 * A [ConnectionFactory] that records the text of every statement any of its connections is asked to create. Unlike [StatementCounter]
 * (an Exposed interceptor of ONE transaction) it also sees the statements of a service that opens its own transaction, which is what
 * a whole view's statement count needs ([HomeViewSizeTest]). Unpooled; use through [countingDatabase].
 */
class CountingConnectionFactory(private val delegate: ConnectionFactory) : ConnectionFactory by delegate {
    val sql: MutableList<String> = Collections.synchronizedList(mutableListOf())

    override fun create(): Publisher<out Connection> = Mono.from(delegate.create()).map { CountingConnection(it, sql) }

    private class CountingConnection(private val inner: Connection, private val sink: MutableList<String>) : Connection by inner {
        override fun createStatement(sql: String): Statement {
            sink += sql
            return inner.createStatement(sql)
        }
    }
}

/** A database on the shared test container whose statements the returned factory records (a service built on it is counted whole). */
fun countingDatabase(): Pair<R2dbcDatabase, CountingConnectionFactory> {
    val options = ConnectionFactoryOptions.parse(PostgresTestSupport.r2dbcUrl)
        .mutate()
        .option(ConnectionFactoryOptions.USER, PostgresTestSupport.user)
        .option(ConnectionFactoryOptions.PASSWORD, PostgresTestSupport.password)
        .build()
    val factory = CountingConnectionFactory(ConnectionFactories.get(options))
    val config = R2dbcDatabaseConfig.Builder().apply {
        connectionFactoryOptions = options
        defaultMaxAttempts = 1
    }
    return R2dbcDatabase.connect(connectionFactory = factory, databaseConfig = config) to factory
}
