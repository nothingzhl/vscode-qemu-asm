bits 16
org 0x7c00
; 用于断点、单步、寄存器和调用堆栈集成验证的实模式引导程序。
jmp 0x0000:boot
boot:
    cli
    xor ax, ax
    mov ds, ax
    mov ss, ax
    mov sp, 0x7c00
    mov ax, 0x1234
    call worker
finished:
    hlt
    jmp finished
worker:
    push bp
    mov bp, sp
    push ax
    mov bx, 0x5678
    pop ax
    pop bp
    ret
message db '调试中文路径', 13, 10, 0
times 510-($-$$) db 0
dw 0xaa55
