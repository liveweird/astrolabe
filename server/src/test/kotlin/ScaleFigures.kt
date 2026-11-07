package ch.nokillswit

import java.util.Locale

/**
 * The timing helpers of the scale tests (`LoadKernelsScaleTest`, `ScheduleKernelsScaleTest`, `TeamScheduleBatchHoldTimeTest`).
 * Each test prints its figures as `scale-figure<TAB><name><TAB><value>` lines (Gradle puts them in the suite's system-out, like the
 * fixture-cost marker; the marker is deliberately NOT `fixture-cost`, which `local-times.mjs` subtracts from the suite's time). A
 * tripwire asserts a LOOSE bound on the median (at least 5x the figure measured on the dev machine), so a slower runner never flakes
 * it and a real regression of an order of magnitude still fails.
 */
internal object ScaleFigures {
    /** Milliseconds of [block] (monotonic clock), result discarded. */
    fun timedMs(block: () -> Unit): Double {
        val started = System.nanoTime()
        block()
        return (System.nanoTime() - started) / NANOS_PER_MILLI
    }

    /** [warmups] untimed calls, then [runs] timed ones; the timings in call order. */
    fun series(warmups: Int, runs: Int, block: () -> Unit): List<Double> {
        repeat(warmups) { block() }
        return List(runs) { timedMs(block) }
    }

    fun median(values: List<Double>): Double = values.sorted().let { (it[(it.size - 1) / 2] + it[it.size / 2]) / 2.0 }

    /** Prints one figure line. */
    fun print(name: String, ms: Double) {
        println("scale-figure\t$name\t${String.format(Locale.ROOT, "%.1f", ms)} ms")
    }

    /** Prints one size figure line (a document's bytes). */
    fun printBytes(name: String, bytes: Int) {
        println("scale-figure\t$name\t$bytes B")
    }

    /** Prints the median and the maximum of [timings] as `<name> median` / `<name> max`. */
    fun printSeries(name: String, timings: List<Double>) {
        print("$name median", median(timings))
        print("$name max", timings.max())
    }

    private const val NANOS_PER_MILLI = 1_000_000.0
}
