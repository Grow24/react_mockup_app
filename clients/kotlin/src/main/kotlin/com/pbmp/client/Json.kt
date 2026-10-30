package com.pbmp.client

// A small JSON reader and writer so the client needs no dependencies on Android or the JVM.
// Objects become Map<String, Any?>, arrays List<Any?>, whole numbers Long, other numbers Double.
object Json {
    fun parse(text: String): Any? = Reader(text).run { val value = read(); skipSpace(); require(at == text.length) { "Trailing JSON at $at" }; value }

    fun write(value: Any?): String = StringBuilder().also { append(it, value) }.toString()

    private fun append(out: StringBuilder, value: Any?) {
        when (value) {
            null -> out.append("null")
            is String -> quote(out, value)
            is Boolean -> out.append(value)
            is Int, is Long -> out.append(value)
            is Float, is Double -> {
                val number = (value as Number).toDouble()
                require(number.isFinite()) { "JSON cannot hold $number" }
                if (number == Math.floor(number) && Math.abs(number) < 1e15) out.append(number.toLong()) else out.append(number)
            }
            is Map<*, *> -> {
                out.append('{')
                var first = true
                for ((key, item) in value) {
                    if (item == null) continue
                    if (!first) out.append(',')
                    first = false
                    quote(out, key.toString())
                    out.append(':')
                    append(out, item)
                }
                out.append('}')
            }
            is Iterable<*> -> {
                out.append('[')
                value.forEachIndexed { index, item -> if (index > 0) out.append(','); append(out, item) }
                out.append(']')
            }
            else -> throw IllegalArgumentException("Cannot write ${value::class} as JSON")
        }
    }

    private fun quote(out: StringBuilder, text: String) {
        out.append('"')
        for (char in text) {
            when {
                char == '"' -> out.append("\\\"")
                char == '\\' -> out.append("\\\\")
                char == '\n' -> out.append("\\n")
                char == '\r' -> out.append("\\r")
                char == '\t' -> out.append("\\t")
                char < ' ' -> out.append(String.format("\\u%04x", char.code))
                else -> out.append(char)
            }
        }
        out.append('"')
    }

    private class Reader(val text: String) {
        var at = 0

        fun skipSpace() {
            while (at < text.length && text[at].isWhitespace()) at += 1
        }

        fun read(): Any? {
            skipSpace()
            require(at < text.length) { "JSON ends early" }
            return when (text[at]) {
                '{' -> readObject()
                '[' -> readArray()
                '"' -> readString()
                't' -> literal("true", true)
                'f' -> literal("false", false)
                'n' -> literal("null", null)
                else -> readNumber()
            }
        }

        fun literal(word: String, value: Any?): Any? {
            require(text.startsWith(word, at)) { "Bad JSON at $at" }
            at += word.length
            return value
        }

        fun readObject(): Map<String, Any?> {
            val map = LinkedHashMap<String, Any?>()
            at += 1
            skipSpace()
            if (text[at] == '}') { at += 1; return map }
            while (true) {
                skipSpace()
                val key = readString()
                skipSpace()
                require(text[at] == ':') { "Expected : at $at" }
                at += 1
                map[key] = read()
                skipSpace()
                when (text[at]) {
                    ',' -> at += 1
                    '}' -> { at += 1; return map }
                    else -> throw IllegalArgumentException("Expected , or } at $at")
                }
            }
        }

        fun readArray(): List<Any?> {
            val list = ArrayList<Any?>()
            at += 1
            skipSpace()
            if (text[at] == ']') { at += 1; return list }
            while (true) {
                list.add(read())
                skipSpace()
                when (text[at]) {
                    ',' -> at += 1
                    ']' -> { at += 1; return list }
                    else -> throw IllegalArgumentException("Expected , or ] at $at")
                }
            }
        }

        fun readString(): String {
            require(text[at] == '"') { "Expected a string at $at" }
            at += 1
            val out = StringBuilder()
            while (true) {
                val char = text[at++]
                when (char) {
                    '"' -> return out.toString()
                    '\\' -> {
                        when (val escape = text[at++]) {
                            '"', '\\', '/' -> out.append(escape)
                            'b' -> out.append('\b')
                            'f' -> out.append('\u000c')
                            'n' -> out.append('\n')
                            'r' -> out.append('\r')
                            't' -> out.append('\t')
                            'u' -> { out.append(text.substring(at, at + 4).toInt(16).toChar()); at += 4 }
                            else -> throw IllegalArgumentException("Bad escape at $at")
                        }
                    }
                    else -> out.append(char)
                }
            }
        }

        fun readNumber(): Number {
            val start = at
            while (at < text.length && (text[at].isDigit() || text[at] in "+-.eE")) at += 1
            val raw = text.substring(start, at)
            require(raw.isNotEmpty()) { "Bad JSON at $start" }
            return if (raw.any { it in ".eE" }) raw.toDouble() else raw.toLongOrNull() ?: raw.toDouble()
        }
    }
}

internal typealias JsonObject = Map<String, Any?>

@Suppress("UNCHECKED_CAST")
internal fun JsonObject.obj(key: String): JsonObject = this[key] as JsonObject
@Suppress("UNCHECKED_CAST")
internal fun JsonObject.optObj(key: String): JsonObject? = this[key] as JsonObject?
@Suppress("UNCHECKED_CAST")
internal fun JsonObject.objects(key: String): List<JsonObject> = (this[key] as? List<JsonObject>) ?: emptyList()
internal fun JsonObject.str(key: String): String = this[key] as String
internal fun JsonObject.optStr(key: String): String? = this[key] as String?
internal fun JsonObject.num(key: String): Double = (this[key] as Number).toDouble()
internal fun JsonObject.optNum(key: String): Double? = (this[key] as Number?)?.toDouble()
internal fun JsonObject.long(key: String): Long = (this[key] as Number).toLong()
internal fun JsonObject.optLong(key: String): Long? = (this[key] as Number?)?.toLong()
internal fun JsonObject.strings(key: String): List<String> = (this[key] as? List<*>)?.map { it as String } ?: emptyList()
