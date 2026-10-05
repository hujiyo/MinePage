# MinePage 后端镜像
# 构建：docker build -t minepage-backend .

FROM python:3.12-slim

# 不写 .pyc、日志直接输出（容器里更该这么干）
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /srv

# 先只拷依赖描述，让这一层能被缓存住 —— 改代码不用重装依赖
COPY pyproject.toml ./
COPY app/__init__.py ./app/
RUN pip install --no-cache-dir .

# 再拷真正的代码
COPY app ./app
COPY alembic ./alembic
COPY alembic.ini ./

# 前端静态文件在 docker-compose 里以只读卷挂到 /srv/public
ENV PUBLIC_DIR=/srv/public

EXPOSE 3000

# 建表交给显式的 `alembic upgrade head`，不在启动时自动建
# （避免多实例同时启动时并发建表）
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "3000"]
