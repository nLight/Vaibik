/* Minimal Zephyr surface for compiling firmware/common/session.c on the host. */
#ifndef VIBEMIC_TEST_ZEPHYR_KERNEL_H
#define VIBEMIC_TEST_ZEPHYR_KERNEL_H

#include <stddef.h>
#include <stdint.h>

#define IS_ENABLED(config) (config)
#define ARRAY_SIZE(array) (sizeof(array) / sizeof((array)[0]))
#define BUILD_ASSERT(...) _Static_assert(__VA_ARGS__, "BUILD_ASSERT")

struct k_spinlock {
	int unused;
};
typedef int k_spinlock_key_t;

static inline k_spinlock_key_t k_spin_lock(struct k_spinlock *lock)
{
	(void)lock;
	return 0;
}

static inline void k_spin_unlock(struct k_spinlock *lock, k_spinlock_key_t key)
{
	(void)lock;
	(void)key;
}

#endif
