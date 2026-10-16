export const MARKER = 'QEMU_ASM_BOOT_OK';
export const example = `bits 16
org 0x7c00
cli
xor ax, ax
mov ds, ax
mov ss, ax
mov sp, 0x7c00
xor bp, bp
cld
; VGA 文本模式，右侧模拟显示器显示实际 BIOS 输出
mov ax, 0x0003
int 0x10
; COM1: 115200 baud, 8N1, FIFO enabled
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
mov si, message
next:
lodsb
test al, al
jz done
mov bl, al
call write_char
jmp next
; BP 栈帧：暂停在此函数可查看返回地址与栈内存
write_char:
push bp
mov bp, sp
push ax
wait_tx:
mov dx, 0x3fd
in al, dx
test al, 0x20
jz wait_tx
mov dx, 0x3f8
mov al, bl
out dx, al
; 同时通过 BIOS 显示字符，串口日志仍可用于无界面验证
push bx
push si
mov al, bl
mov ah, 0x0e
xor bh, bh
int 0x10
pop si
pop bx
pop ax
pop bp
ret
done:
hlt
jmp done
message db '${MARKER}', 13, 10, 0
times 510-($-$$) db 0
dw 0xaa55
`;
