#ifndef VIBEMIC_TEST_ZEPHYR_LOG_H
#define VIBEMIC_TEST_ZEPHYR_LOG_H

#define LOG_MODULE_REGISTER(name, level) extern int vm_test_log_module_##name
#define LOG_INF(...) vm_test_log(__VA_ARGS__)

static inline void vm_test_log(const char *format, ...)
{
	(void)format;
}

#endif
