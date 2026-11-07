#ifndef VIBEMIC_CAPTURE_H
#define VIBEMIC_CAPTURE_H

#include "protocol.h"

int vm_capture_start(void);
int vm_capture_read(int16_t *pcm);
int vm_capture_stop(void);

#endif
