# Integration recipe for dreamos82/Dreamos 85393cbcdeb9ca0bafb84e9631c2c7f21be76141.
# Include the upstream build; do not replace its kernel sources, linker or loader.
include Makefile
CC = gcc -fcommon -fno-pie -no-pie
CFLAGS := $(filter-out -fomit-frame-pointer,$(CFLAGS)) -fno-omit-frame-pointer

.PHONY: toolkit-iso
toolkit-iso: generated/dreamos.img
	cp generated/dreamos.img dreamos.img
	# The original ISO script expects dreamos.img at the project root.
	# Change only the GRUB menu delay in the staging directory for automated runs.
	sed -i 's/^timeout=.*/timeout=0/' utils/eltorito_iso/boot/grub/menu.lst
	# The upstream script is not executable in its Git tree; invoke its interpreter.
	bash utils/eltorito_gen.sh
