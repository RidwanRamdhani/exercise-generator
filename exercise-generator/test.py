def binary_io(filename):
    data_byte = b'\x48\x65\x6c\x6c\x6f'
    with open(filename, 'wb') as f:
        f.write(data_byte)
    with open(filename, 'rb') as f:
        return f.read().decode('utf-8')
    
assert binary_io('data.bin') == 'Hello'
assert binary_io('temp.bin') == 'Hello'
assert isinstance(binary_io('sample.bin'), str)