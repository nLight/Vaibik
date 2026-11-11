#ifndef VIBEMIC_BATTERY_H
#define VIBEMIC_BATTERY_H

#include "protocol.h"

void vm_battery_start(void);
struct vm_battery vm_battery_read(void);

#endif
