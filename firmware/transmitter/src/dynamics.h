#ifndef VIBEMIC_DYNAMICS_H
#define VIBEMIC_DYNAMICS_H

#include "protocol.h"

struct vm_dynamics {
	int32_t gain_q12;
};

void vm_dynamics_reset(struct vm_dynamics *state);
void vm_dynamics_process(struct vm_dynamics *state, int16_t pcm[VM_BLOCK_SAMPLES]);

#endif
