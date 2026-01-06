### Building on Rocky:

```
dnf install libzfs5-devel python3-devel -y
pip3 install Cython==0.29.35
git clone https://github.com/45Drives/python3-libzfs.git && cd python3-libzfs
./configure --prefix=/usr
make
make install
```