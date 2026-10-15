export const PROTECTED_MARKER = 'PROTECTED_MODE_OK';
export const protectedBootExample = `bits 16
org 0x7c00
; BIOS 只装入本扇区；构建器把 stage2 放在 LBA 1，并给出扇区数。
cli
xor ax, ax
mov ds, ax
mov es, ax
mov ss, ax
mov sp, 0x7c00
cld
mov [boot_drive], dl
mov ax, 0x0003
int 0x10
sti
mov bx, 0x8000
mov ah, 0x02
mov al, STAGE2_SECTORS
mov ch, 0
mov cl, 2
mov dh, 0
mov dl, [boot_drive]
int 0x13
jc disk_error
cli
jmp 0x0000:0x8000
disk_error:
cli
hlt
jmp disk_error
boot_drive db 0
times 510-($-$$) db 0
dw 0xaa55
`;
export const protectedStageExample = `bits 16
org 0x8000
cli
xor ax, ax
mov ds, ax
cld
; COM1 初始化后可以在无界面集成验证中观察保护模式成功标记。
mov dx, 0x3f9
xor al, al
out dx, al
mov dx, 0x3fb
mov al, 0x80
out dx, al
mov dx, 0x3f8
mov al, 1
out dx, al
mov dx, 0x3f9
xor al, al
out dx, al
mov dx, 0x3fb
mov al, 3
out dx, al
mov dx, 0x3fa
mov al, 0xc7
out dx, al
mov dx, 0x3fc
mov al, 0x0b
out dx, al
lgdt [gdt_descriptor]
mov eax, cr0
or eax, 1
mov cr0, eax
jmp 0x08:protected_entry

align 8
gdt:
dq 0
; 平坦 32 位代码段与数据段，base=0、limit=4GB。
dq 0x00cf9a000000ffff
dq 0x00cf92000000ffff
gdt_end:
gdt_descriptor:
dw gdt_end-gdt-1
dd gdt

bits 32
protected_entry:
mov ax, 0x10
mov ds, ax
mov es, ax
mov fs, ax
mov gs, ax
mov ss, ax
mov esp, 0x90000
xor ebp, ebp
; 只安装可供查看的最小 IDT：向量 3 指向下方的 IRETD 处理器。
; 本课仍保持 IF=0，不触发中断；不要把它当作完整异常处理表。
lidt [idt_descriptor]
inspection_ready:
mov esi, message
mov edi, 0xb8000
print_next:
lodsb
test al, al
jz print_done
mov ah, 0x0a
mov [edi], ax
add edi, 2
mov bl, al
serial_wait:
mov dx, 0x3fd
in al, dx
test al, 0x20
jz serial_wait
mov dx, 0x3f8
mov al, bl
out dx, al
jmp print_next
print_done:
call learning_entry
after_call:
idle:
hlt
jmp idle

; 在下面两个函数里设置断点，观察 EAX、ESP、EBP 与返回地址。
learning_entry:
push ebp
mov ebp, esp
mov eax, 0x11223344
push eax
call learning_nested
add esp, 4
pop ebp
ret
protected_worker:
learning_nested:
push ebp
mov ebp, esp
mov ebx, [ebp+8]
; EDI 指向下面的数据区；复制寄存器 EDI 的值到内存地址框，观察三个双字。
mov edi, inspection_data
learning_breakpoint:
nop
; 在内存查看器中观察第三个双字：单步执行后由 0 变为 1。
inc dword [inspection_data+8]
inspection_changed:
pop ebp
ret

inspection_handler:
iretd

align 8
idt:
dq 0
dq 0
dq 0
; 32 位中断门：偏移低 16 位、代码选择子、保留字节、P/DPL/type、高 16 位。
; 整个 stage2 位于 0x8000..0x83ff，因此处理器偏移的高 16 位为 0。
dw inspection_handler
dw 0x08
db 0
db 0x8e
dw 0
idt_end:
idt_descriptor:
dw idt_end-idt-1
dd idt
align 4
; 小端布局：44 33 22 11 88 77 66 55 00 00 00 00。
inspection_data:
dd 0x11223344, 0x55667788, 0
; 成功字符串位于第二个扇区，真实引导验证必须读到它。
times 768-($-$$) db 0
message db '${PROTECTED_MARKER}', 13, 10, 0
; 二阶段刻意超过 512B，验证从磁盘读取多个扇区。
times 1024-($-$$) db 0
`;
