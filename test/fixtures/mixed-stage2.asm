bits 16
org 0x8000
; 独立编译的第二阶段：listing 同时覆盖实模式和 32 位保护模式。
start:
    cli
    lgdt [gdt_descriptor]
    mov eax, cr0
    or eax, 1
    mov cr0, eax
    jmp 0x08:protected_entry

bits 32
protected_entry:
    mov ax, 0x10
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov esp, 0x90000
    mov eax, 0x12345678
    call worker
finished:
    hlt
    jmp finished
worker:
    push ebp
    mov ebp, esp
    push eax
    mov ebx, 0x87654321
    pop eax
    pop ebp
    ret

align 8
gdt:
    dq 0
    dq 0x00cf9a000000ffff
    dq 0x00cf92000000ffff
gdt_end:
gdt_descriptor:
    dw gdt_end - gdt - 1
    dd gdt
message db 'stage 2; protected mode', 0
times 640-($-$$) db 0
