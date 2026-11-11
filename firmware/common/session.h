#ifndef VIBEMIC_SESSION_H
#define VIBEMIC_SESSION_H

#include <stddef.h>
#include <stdint.h>

void vm_session_accept(const uint8_t *wire, size_t size, uint8_t rssi, uint32_t now);
void vm_session_tick(uint32_t now);
void vm_session_reset(void);

#endif
